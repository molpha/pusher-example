# molpha-pusher

High-frequency push feeds on [Molpha](https://molpha.io). It drives a set of price feeds at
4 updates per second each, gets every update threshold-signed by Molpha nodes, and submits
them to Solana in order. It also ships a consumer-side watcher that measures what actually
lands on-chain.

Built only on the public [`@molpha/sdk`](https://www.npmjs.com/package/@molpha/sdk) API, so
it doubles as a reference for running your own pusher.

> **Status:** demo on Solana devnet against a pre-audit protocol. Not for production funds.

```text
            every 250 ms per feed                  one tx in flight per feed
 ┌────────┐  requestSignedData  ┌─────────┐  queue   ┌───────────┐  submit_attestation ×n  ┌────────┐
 │ pusher │ ──────────────────▶ │ gateway │ ───────▶ │ ordered   │ ──────────────────────▶ │ Solana │
 │ (you)  │ ◀── attestation ─── │ + nodes │          │ batcher   │   (atomic, oldest first) │  Feed  │
 └────────┘                     └─────────┘          └───────────┘                         └───┬────┘
                                                                                               │ account
                                                                     ┌─────────┐   websocket   │ notifications
                                                                     │ watcher │ ◀─────────────┘
                                                                     └─────────┘
```

## How it works

**Signing.** Each feed is a source (an API config) plus a quorum. Every `intervalMs` the
pusher asks the gateway for a round. The selected nodes fetch the source independently.
In median tolerance mode they exchange observations and sign the lower median. The gateway
stamps each round on a 100 ms grid, so one feed can run up to 10 rounds per second.

**Submitting.** The Molpha program refuses an update that is not newer than the feed
(`FeedNotNewer`). Separate transactions sent 250 ms apart often reach the leader out of
order: the SDK docs report about a third at that spacing in a devnet run. So the pusher:

- keeps **one transaction in flight per feed**;
- queues rounds that finish while it confirms, sorted by round timestamp;
- sends the queue as **one transaction with several `submit_attestation` instructions**,
  applied oldest first and atomically (`submitAttestations`).

The batch size adapts to confirmation latency. With confirms around 500 ms at 4 Hz, a
transaction carries about two updates, so 5 feeds cost about 10 tx/s rather than 20. A
round that finishes after a newer one has already been sent can never land, and is dropped
and counted as `late`. A confirmation timeout is checked against the feed account before
anything is resent.

**Modes.**

| Mode | Behaviour | Use when |
|---|---|---|
| `--mode all` (default) | Every update is pushed, in order. | You need the full on-chain history. |
| `--mode latest` | Only the newest queued update is sent; the rest are skipped. | Freshness matters more than every tick. |

## Quick start

Requires Node.js ≥ 20.19 and a Solana devnet keypair with some SOL.

```bash
git clone <this repo> && cd molpha-pusher
npm install
cp .env.example .env            # set RPC_URL and KEYPAIR_PATH
```

**1. Subscription.** Rounds are paid from a Molpha subscription (USDC on Solana). Test USDC
on devnet comes from [faucet.circle.com](https://faucet.circle.com/). Subscribe once with
the SDK, as in its [quick start](https://github.com/Molpha/sdk#quick-start), or use the
keypair of a delegate on an existing subscription.

**2. Check the setup.**

```bash
npm run info     # payer, subscription and quota, registry, feed addresses, burn rate
npm run probe    # one signed round per feed, no submit: are the sources reachable and agreed on?
```

**3. Measure the signing path only.** Spends rounds, no SOL:

```bash
npm run push -- --no-submit --duration 60
```

**4. Push.**

```bash
npm run push -- --duration 300 --max-rounds 6000
```

**5. Watch from the consumer side.** Run this in another terminal or on another machine.
It needs only an RPC endpoint, no subscription:

```bash
npm run watch -- --submitter <pusher pubkey>
```

Both commands write a JSON report to `reports/` on exit (Ctrl-C or `--duration`).

## Reading the numbers

**`push` dashboard**

| Column | Meaning |
|---|---|
| `rnd/s` | Signed rounds per second (10 s window). |
| `round p50/p95` | Request → signed attestation at the pusher, ms. |
| `landed/s` | Updates confirmed on-chain per second. |
| `batch` | Mean updates per transaction. |
| `confirm p50/p95` | Transaction send → confirmed at `COMMITMENT`, ms. |
| `age@chain p50/p95` | Round timestamp → confirmed on-chain, ms. How old a price is when a reader can first see it. |
| `lost` | Updates signed but never landed: `late` + `expired` + over-backlog + given up + stale. Broken down in the report. |

**`watch` dashboard**

| Column | Meaning |
|---|---|
| `seen/s` | Distinct on-chain values observed per second. Notifications are per slot, so several updates landing in one slot show as one. A program reading the feed in a later slot sees the same. |
| `spacing` | Time between consecutive observed round timestamps. |
| `age` | Local clock − round timestamp when the notification arrives. Keep clocks NTP-synced. |
| `gaps` | Spacings longer than 2× the feed interval. |

## Cost model

For 5 feeds at 4 Hz:

| | Per second | Per day |
|---|---|---|
| Signed rounds (subscription quota) | 20 | 1,728,000 |
| Transactions, ~2 updates each | ~10 | ~864,000 |
| Base fees at 5,000 lamports/tx | — | ~4.3 SOL |

Priority fees come on top. They are what make submits land under load, and `PRIORITY_FEE=auto`
pays the 75th percentile recently paid on the feed. The `push` report gives the actual SOL
spent (balance delta, which also includes the one-time rent for new feed accounts).

Every node in a round fetches the source itself. Size the sources' rate limits for
`rounds/s × (quorum + redundancy buffer)` requests.

## Configuring feeds

`config/feeds.json` holds the feed set. The default is SOL, BTC, ETH and SUI from Coinbase
Exchange plus HYPE from Bybit, in median tolerance mode (25 bps, 1 s observation age,
8 decimals), quorum 3, 250 ms. A feed's on-chain identity is
`sourceId = keccak256(canonical apiConfig)`, so editing a URL, parser or aggregation policy
creates a new feed. On Solana a feed account is keyed by `(sourceId, quorum, submitter)`.

Run `npm run probe` after every edit. A source can work from your machine and still fail
for the nodes: geo-blocking, rate limits, or a `responseParser` that does not match.

## Limits and caveats

- **Single-venue sources.** Each default feed reads one exchange. Tolerance mode protects
  against nodes disagreeing about that venue's price, not against the venue being wrong or
  manipulated.
- **Clock skew.** Ages compare your local clock with the gateway's round timestamp.
- **RPC quality decides landing.** The public devnet endpoint rate-limits and drops
  transactions. Use a dedicated RPC for meaningful numbers.
- **Push is not the only option.** Pushing every tick buys a full on-chain history at a
  cost of about 1 tx per 2 updates per feed. If a program needs a fresh price only when
  it acts (open, close, liquidate), carrying the latest attestation into that same
  transaction is cheaper and fresher. That pull-at-use path is a separate integration
  from this demo.

## Development

```bash
npm run typecheck
npm test     # queue unit tests + simulated end-to-end runs (no network)
```

The simulated runs check the ordering guarantees against a fake gateway and chain that
enforce `FeedNotNewer`. They use random round latency, slow confirms, and confirm timeouts
on transactions that did land. They test correctness, not real-world latency.

## License

MIT
