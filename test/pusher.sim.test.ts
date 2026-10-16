/**
 * End-to-end run of FeedPusher against a simulated gateway and chain. No network.
 *
 * The simulated chain enforces the program's ordering rule (an update must be newer than
 * the feed, else FeedNotNewer, and a multi-update transaction is atomic). The gateway
 * stamps rounds on the 100 ms grid with random round latency, so rounds finish out of
 * order. A signature is processed quickly and confirmed later, and confirmation sometimes
 * never arrives for a transaction that did land.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { web3 } from "@anchor-lang/core";
import { encodeInt256Decimal, type MolphaSDK } from "@molpha/sdk";
import type { FeedSpec } from "../src/config.js";
import { ContextCache, FeedPusher, RoundBudget, type PusherOptions, type SignatureStatus } from "../src/pusher.js";
import { sendWithoutConfirm } from "../src/sdk.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Tracked {
  atts: Array<{ payload: { sourceId: string; timestamp: number } }>;
  processedAt: number;
  confirmedAt: number;
  confirmFails: boolean;
  applied: boolean;
  err?: unknown;
}

function makeSim(seed = 7, falseTimeoutRate = 0.05) {
  let s = seed;
  const rand = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const onchain = new Map<string, number>(); // sourceId -> feed timestamp
  const writes: number[] = []; // every applied timestamp, in apply order
  const tickTaken = new Set<string>();
  const tracks = new Map<string, Tracked>();
  let txs = 0;
  let falseTimeouts = 0;
  let overlaps = 0;

  const apply = (atts: Tracked["atts"]) => {
    const sorted = [...atts].sort((a, b) => a.payload.timestamp - b.payload.timestamp);
    const id = sorted[0]!.payload.sourceId;
    let cur = onchain.get(id) ?? 0;
    for (const a of sorted) {
      if (a.payload.timestamp <= cur) throw new Error("AnchorError: FeedNotNewer. Error Number: 6030");
      cur = a.payload.timestamp;
    }
    onchain.set(id, cur);
    for (const a of sorted) writes.push(a.payload.timestamp);
  };

  const signatureStatus = (signature: string): SignatureStatus | null => {
    const t = tracks.get(signature);
    if (!t || Date.now() < t.processedAt) return null;
    if (!t.applied) {
      t.applied = true;
      try {
        apply(t.atts);
      } catch (err) {
        t.err = err;
      }
    }
    if (t.err) return { err: t.err, confirmationStatus: "processed" };
    if (!t.confirmFails && Date.now() >= t.confirmedAt) return { err: null, confirmationStatus: "confirmed" };
    return { err: null, confirmationStatus: "processed" };
  };

  const submit = async (atts: Tracked["atts"]) => {
    txs++;
    const now = Date.now();
    if ([...tracks.values()].some((t) => t.applied && now < t.confirmedAt)) overlaps++;
    const signature = `sig-${txs}`;
    const confirmFails = rand() < falseTimeoutRate;
    if (confirmFails) falseTimeouts++;
    tracks.set(signature, {
      atts,
      processedAt: now + 400,
      confirmedAt: now + 1_200,
      confirmFails,
      applied: false,
    });
    return { signature, feed: "feed" };
  };

  const statuses = {
    getSignatureStatuses: async (signatures: string[]) => ({
      value: signatures.map((sig) => signatureStatus(sig)),
    }),
  };

  const sdk = {
    gateway: {
      prepareContext: async () => ({ registryVersion: 1, redundancyBuffer: 2, nodeCount: 5, nodes: [] }),
      requestSignedData: async ({ apiConfig, signaturesRequired }: any) => {
        const ts = Math.floor(Date.now() / 100) * 100;
        const key = `${apiConfig.url}:${ts}`;
        if (tickTaken.has(key)) throw new Error("gateway 409");
        tickTaken.add(key);
        await sleep(120 + rand() * 500); // round latency, so rounds finish out of order
        if (rand() < 0.03) throw new Error("gateway 503");
        return {
          payload: {
            value: Buffer.from(encodeInt256Decimal("142.5", 8)).toString("hex"),
            sourceId: apiConfig.url,
            registryVersion: 1,
            signaturesRequired,
            timestamp: ts,
          },
          signature: { signersBitmap: "07" },
          value: "142.5",
          fresh: true,
        };
      },
    },
    solana: {
      submitAttestation: (a: any) => submit([a]),
      submitAttestations: (as: any[]) => submit(as),
      readFeed: async (id: string) => {
        const ts = onchain.get(id);
        return ts === undefined ? null : { timestamp: { toString: () => String(ts) } };
      },
    },
  } as unknown as MolphaSDK;

  return { sdk, writes, onchain, statuses, stats: () => ({ txs, falseTimeouts, overlaps }) };
}

function pusher(
  sim: ReturnType<typeof makeSim>,
  options: PusherOptions,
  budget = new RoundBudget(),
): FeedPusher {
  return new FeedPusher(feed, sim.sdk, new ContextCache(sim.sdk), budget, options, sim.statuses);
}

const feed: FeedSpec = {
  label: "SIM",
  apiConfig: { url: "sim://sol", responseParser: "$.p" },
  signaturesRequired: 3,
  intervalMs: 250,
  decimals: 8,
};

const opts: PusherOptions = {
  mode: "all",
  maxAgeMs: 3000,
  maxBacklog: 12,
  maxInflightRounds: 3,
  roundTimeoutMs: 5000,
  maxSubmitAttempts: 3,
  priorityFee: undefined,
  noSubmit: false,
};

test("4 Hz for 8 s: every landed update is in order, no FeedNotNewer, most rounds land", async () => {
  const sim = makeSim();
  const p = pusher(sim, opts);
  p.start(Date.now());
  await sleep(8000);
  await p.stop(3000);

  const s = p.stats;
  for (let i = 1; i < sim.writes.length; i++) {
    assert.ok(sim.writes[i]! > sim.writes[i - 1]!, "on-chain timestamps strictly increase");
  }
  assert.equal(s.submit.staleRejected, 0, "one tx in flight per feed never produces FeedNotNewer");
  assert.ok(sim.stats().overlaps > 0, "a later transaction was sent before the previous one confirmed");
  assert.equal(s.submit.landed, sim.writes.length, "pusher's landed count matches the chain");
  const lost = p.drops.late + p.drops.expired + p.drops.backlog + s.submit.givenUp;
  assert.equal(s.rounds.ok, s.submit.landed + lost + p.backlog, "every signed round is accounted for");
  assert.ok(s.rounds.started >= 30, `~32 rounds started, got ${s.rounds.started}`);
  assert.ok(s.submit.landed / s.rounds.ok > 0.8, `landed ${s.submit.landed} of ${s.rounds.ok}`);
  assert.ok(s.batchSize.mean() > 1, "processed latency produces batches");
  console.log(
    `rounds ${s.rounds.ok}/${s.rounds.started}, landed ${s.submit.landed} in ${s.submit.txOk} tx ` +
      `(sim tx ${sim.stats().txs}, false timeouts ${sim.stats().falseTimeouts}), ` +
      `late ${p.drops.late}, batch mean ${s.batchSize.mean().toFixed(2)}, ` +
      `age@chain p50 ${s.onchainAgeMs.pct(50)} ms p95 ${s.onchainAgeMs.pct(95)} ms`,
  );
});

test("latest mode pushes fewer transactions and only newer values", async () => {
  const sim = makeSim(11);
  const p = pusher(sim, { ...opts, mode: "latest" });
  p.start(Date.now());
  await sleep(5000);
  await p.stop(3000);
  for (let i = 1; i < sim.writes.length; i++) assert.ok(sim.writes[i]! > sim.writes[i - 1]!);
  assert.equal(p.stats.submit.staleRejected, 0);
  assert.ok(p.drops.superseded > 0, "older updates superseded");
  assert.equal(p.stats.batchSize.max, 1);
});

test("confirm timeouts on landed transactions are detected, not resent", async () => {
  const sim = makeSim(5, 0.4);
  const p = pusher(sim, opts);
  p.start(Date.now());
  await sleep(5000);
  await p.stop(3000);
  assert.ok(sim.stats().falseTimeouts > 0, "the simulation produced false timeouts");
  assert.equal(p.stats.submit.staleRejected, 0, "no landed batch was resent");
  assert.equal(p.stats.submit.failedTx, 0);
  assert.equal(p.stats.submit.landed, sim.writes.length);
});

test("round budget stops new rounds", async () => {
  const sim = makeSim(3);
  const budget = new RoundBudget(6);
  const p = pusher(sim, opts, budget);
  p.start(Date.now());
  await sleep(3000);
  await p.stop(3000);
  assert.equal(p.stats.rounds.started, 6);
  assert.ok(p.stats.rounds.budget > 0);
});

test("broadcast returns the signature without confirming", async () => {
  const payer = web3.Keypair.generate();
  let sent = 0;
  let confirmed = false;
  const provider = {
    opts: {},
    connection: {
      getLatestBlockhash: async () => ({ blockhash: payer.publicKey.toBase58(), lastValidBlockHeight: 1 }),
      sendRawTransaction: async () => {
        sent++;
        return "sig";
      },
      confirmTransaction: async () => {
        confirmed = true;
        throw new Error("confirm should not be called");
      },
    },
    wallet: {
      publicKey: payer.publicKey,
      signTransaction: async (tx: web3.Transaction) => {
        tx.sign(payer);
        return tx;
      },
    },
    sendAndConfirm: async (_tx: web3.Transaction, _signers?: web3.Signer[]) => "unused",
  };
  const sdk = { solana: { provider } } as unknown as MolphaSDK;
  sendWithoutConfirm(sdk);
  const tx = new web3.Transaction().add(
    web3.SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: payer.publicKey,
      lamports: 1,
    }),
  );
  const signature = await provider.sendAndConfirm(tx);
  assert.equal(signature, "sig");
  assert.equal(sent, 1);
  assert.equal(confirmed, false);
});
