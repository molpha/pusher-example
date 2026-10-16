import {
  BatchTooLargeError,
  GatewayError,
  formatInt256Decimal,
  maxAttestationsPerTransaction,
  type Attestation,
  type MolphaSDK,
  type RoundContext,
} from "@molpha/sdk";
import type { Commitment, FeedSpec } from "./config.js";
import { SubmitQueue, type Item, type QueueOptions } from "./queue.js";
import { sendWithoutConfirm } from "./sdk.js";
import { Rate, Samples } from "./stats.js";

/** How long a broadcast signature may stay unseen before it is treated as dropped. */
const PROCESSED_TIMEOUT_MS = 4_000;
/** How long to keep sampling a processed signature for the configured commitment. */
const CONFIRM_TIMEOUT_MS = 20_000;
const STATUS_POLL_MS = 200;

const COMMITMENT_RANK: Record<Commitment, number> = { processed: 1, confirmed: 2, finalized: 3 };

export interface SignatureStatus {
  err: unknown;
  confirmationStatus?: Commitment;
}

/** The slice of `Connection.getSignatureStatuses` the submit lane polls. */
export interface SignatureStatusClient {
  getSignatureStatuses(signatures: string[]): Promise<{ value: Array<SignatureStatus | null> }>;
}

export interface PusherOptions extends QueueOptions {
  /** Most gateway rounds of one feed in flight at once. */
  maxInflightRounds: number;
  /** Per-round gateway timeout. A round slower than this is useless at 4 Hz. */
  roundTimeoutMs: number;
  /** Attempts per update before it is given up on (transient submit failures). */
  maxSubmitAttempts: number;
  /** Priority fee for submits: micro-lamports/CU, "auto", or undefined for none. */
  priorityFee: number | "auto" | undefined;
  /** Request only; never submit (load-tests the signing path without spending SOL). */
  noSubmit: boolean;
  /** Stop starting rounds once this many have been started across all feeds. */
  maxRounds?: number;
  /**
   * Commitment at which `confirmMs` and `onchainAgeMs` are recorded.
   * The next transaction is sent when the previous signature is `processed`.
   */
  commitment?: Commitment;
}

/** Shared, periodically refreshed round context (registry version, selection inputs, nodes). */
export class ContextCache {
  private ctx?: RoundContext;
  private fetchedAt = 0;
  private inflight?: Promise<RoundContext>;
  refreshes = 0;

  constructor(
    private readonly sdk: MolphaSDK,
    private readonly ttlMs = 30_000,
  ) {}

  async get(): Promise<RoundContext> {
    if (this.ctx && Date.now() - this.fetchedAt < this.ttlMs) return this.ctx;
    this.inflight ??= this.sdk.gateway
      .prepareContext()
      .then((ctx) => {
        this.ctx = ctx;
        this.fetchedAt = Date.now();
        this.refreshes++;
        return ctx;
      })
      .finally(() => {
        this.inflight = undefined;
      });
    return this.inflight;
  }

  invalidate(): void {
    this.fetchedAt = 0;
  }

  get registryVersion(): number | undefined {
    return this.ctx?.registryVersion;
  }
}

/** Global round budget shared by every feed. */
export class RoundBudget {
  started = 0;
  constructor(private readonly max?: number) {}
  take(): boolean {
    if (this.max !== undefined && this.started >= this.max) return false;
    this.started++;
    return true;
  }
  get exhausted(): boolean {
    return this.max !== undefined && this.started >= this.max;
  }
}

export interface FeedStats {
  label: string;
  sourceId?: string;
  lastValue?: string;
  lastTs?: number;
  rounds: { started: number; ok: number; failed: number; skippedBusy: number; budget: number };
  roundErrors: Record<string, number>;
  /** Request start -> signed attestation back, ms. */
  roundMs: Samples;
  /** Gateway round timestamp -> attestation back at the pusher, ms. */
  signedAgeMs: Samples;
  submit: { txOk: number; landed: number; staleRejected: number; failedTx: number; givenUp: number };
  submitErrors: Record<string, number>;
  /** Send -> the configured commitment, ms. Does not gate the next send. */
  confirmMs: Samples;
  /** Gateway round timestamp -> the configured commitment, ms. The number Lavarage cares about. */
  onchainAgeMs: Samples;
  batchSize: Samples;
  landedRate: Rate;
  roundRate: Rate;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

function errText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function errName(err: unknown): string {
  if (err instanceof GatewayError) return `gateway ${err.status ?? "?"}`;
  const msg = errText(err);
  if (/FeedNotNewer|0x178e|Error Number: 6030|"Custom":\s*6030/i.test(msg)) return "FeedNotNewer";
  if (/timeout|timed out|abort/i.test(msg)) return "timeout";
  if (/block ?height exceeded|expired/i.test(msg)) return "blockhash expired";
  if (/registry/i.test(msg)) return "registry";
  if (/\b(503|429)\b/.test(msg)) return "gateway busy";
  return msg.split("\n")[0]!.slice(0, 60);
}

function bump(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

function reached(status: Commitment | undefined, target: Commitment): boolean {
  return status !== undefined && COMMITMENT_RANK[status] >= COMMITMENT_RANK[target];
}

/**
 * Drives one feed: starts a gateway round every `intervalMs`, queues the signed
 * attestations by timestamp, and submits them to Solana one transaction at a time
 * (adaptive batches, oldest first). The next transaction is sent when the previous
 * signature is processed. Confirmation at {@link PusherOptions.commitment} is recorded
 * in the background and does not hold the lane.
 */
export class FeedPusher {
  readonly stats: FeedStats;
  private readonly queue: SubmitQueue<Attestation>;
  private running = false;
  private inflightRounds = 0;
  private wake?: () => void;
  private maxBatch = 3;
  private submitLoopDone?: Promise<void>;
  private timer?: NodeJS.Timeout;
  private readonly pendingRounds = new Set<Promise<void>>();
  private readonly pendingConfirms = new Set<Promise<void>>();
  private readonly confirmAbort = new AbortController();

  constructor(
    readonly feed: FeedSpec,
    private readonly sdk: MolphaSDK,
    private readonly ctx: ContextCache,
    private readonly budget: RoundBudget,
    private readonly opts: PusherOptions,
    private readonly statuses?: SignatureStatusClient,
  ) {
    sendWithoutConfirm(sdk);
    this.queue = new SubmitQueue<Attestation>(opts);
    this.stats = {
      label: feed.label,
      rounds: { started: 0, ok: 0, failed: 0, skippedBusy: 0, budget: 0 },
      roundErrors: {},
      roundMs: new Samples(),
      signedAgeMs: new Samples(),
      submit: { txOk: 0, landed: 0, staleRejected: 0, failedTx: 0, givenUp: 0 },
      submitErrors: {},
      confirmMs: new Samples(),
      onchainAgeMs: new Samples(),
      batchSize: new Samples(),
      landedRate: new Rate(),
      roundRate: new Rate(),
    };
    // Size the batch for the quorum; refined from BatchTooLargeError if a batch
    // with more signers (a different set per attestation) does not fit.
    this.maxBatch = Math.max(
      1,
      maxAttestationsPerTransaction(feed.signaturesRequired, {
        priorityFee: opts.priorityFee !== undefined,
      }),
    );
  }

  get drops() {
    return this.queue.drops;
  }

  get backlog(): number {
    return this.queue.length;
  }

  start(startAt: number): void {
    this.running = true;
    if (!this.opts.noSubmit) this.submitLoopDone = this.submitLoop();
    // Drift-free schedule: tick k fires at startAt + k * interval.
    let k = 0;
    const schedule = () => {
      if (!this.running) return;
      const due = startAt + k * this.feed.intervalMs;
      k++;
      this.timer = setTimeout(
        () => {
          this.tick();
          schedule();
        },
        Math.max(0, due - Date.now()),
      );
    };
    schedule();
  }

  /** Stop starting rounds, let in-flight rounds finish, drain the queue. */
  async stop(drainMs = 5_000): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    await Promise.race([Promise.allSettled([...this.pendingRounds]), sleep(drainMs)]);
    this.wake?.();
    if (this.submitLoopDone) await Promise.race([this.submitLoopDone, sleep(drainMs)]);
    this.confirmAbort.abort();
    await Promise.allSettled([...this.pendingConfirms]);
  }

  private tick(): void {
    if (this.inflightRounds >= this.opts.maxInflightRounds) {
      this.stats.rounds.skippedBusy++;
      return;
    }
    if (!this.budget.take()) {
      this.stats.rounds.budget++;
      return;
    }
    const p = this.runRound().finally(() => this.pendingRounds.delete(p));
    this.pendingRounds.add(p);
  }

  private async runRound(): Promise<void> {
    this.inflightRounds++;
    this.stats.rounds.started++;
    const t0 = Date.now();
    try {
      const context = await this.ctx.get();
      const att = await this.sdk.gateway.requestSignedData({
        apiConfig: this.feed.apiConfig,
        signaturesRequired: this.feed.signaturesRequired,
        context,
        // At 4 Hz the next tick is the retry: an SDK retry would be a new round
        // (more quota) arriving later than the round it replaces.
        maxRetries: 1,
        timeoutMs: this.opts.roundTimeoutMs,
      });
      const now = Date.now();
      this.stats.rounds.ok++;
      this.stats.roundRate.hit(now);
      this.stats.roundMs.add(now - t0);
      this.stats.signedAgeMs.add(now - att.payload.timestamp);
      this.stats.sourceId = att.payload.sourceId;
      this.stats.lastValue =
        this.feed.decimals !== undefined
          ? formatInt256Decimal(att.payload.value, this.feed.decimals)
          : att.value;
      this.stats.lastTs = att.payload.timestamp;
      if (!this.opts.noSubmit && this.queue.add(att.payload.timestamp, att, now)) this.wake?.();
    } catch (err) {
      this.stats.rounds.failed++;
      const name = errName(err);
      bump(this.stats.roundErrors, name);
      if (name === "registry") this.ctx.invalidate();
    } finally {
      this.inflightRounds--;
    }
  }

  private async submitLoop(): Promise<void> {
    while (this.running || this.queue.length > 0) {
      if (this.queue.length === 0) {
        await new Promise<void>((r) => (this.wake = r));
        this.wake = undefined;
        continue;
      }
      const batch = this.queue.take(this.maxBatch);
      if (batch.length === 0) continue;
      await this.submit(batch);
    }
  }

  private async submit(batch: Item<Attestation>[]): Promise<void> {
    const sentAt = Date.now();
    let signature: string;
    try {
      signature = await this.broadcast(batch);
    } catch (err) {
      await this.onBroadcastError(batch, err, sentAt);
      return;
    }
    // One execution deep: the account is free once the signature is processed.
    // Confirmation at the configured commitment does not hold the next batch.
    const status = await this.pollStatus(signature, "processed", PROCESSED_TIMEOUT_MS);
    if (status === "timeout") {
      if (await this.landedAnyway(batch)) {
        this.markExecuted(batch);
        this.watchConfirmed(signature, batch, sentAt);
        return;
      }
      this.stats.submit.failedTx++;
      bump(this.stats.submitErrors, "timeout");
      this.stats.submit.givenUp += this.queue.requeue(batch, this.opts.maxSubmitAttempts);
      return;
    }
    if (status.err) {
      const name = errName(status.err);
      bump(this.stats.submitErrors, name);
      if (name === "FeedNotNewer") {
        this.stats.submit.staleRejected += batch.length;
        this.queue.rejectedStale(batch);
        return;
      }
      if (await this.landedAnyway(batch)) {
        this.markExecuted(batch);
        this.watchConfirmed(signature, batch, sentAt);
        return;
      }
      this.stats.submit.failedTx++;
      this.stats.submit.givenUp += this.queue.requeue(batch, this.opts.maxSubmitAttempts);
      return;
    }
    this.markExecuted(batch);
    const commitment = this.opts.commitment ?? "confirmed";
    if (reached(status.confirmationStatus, commitment)) this.markConfirmed(batch, sentAt);
    else this.watchConfirmed(signature, batch, sentAt);
  }

  private async broadcast(batch: Item<Attestation>[]): Promise<string> {
    const attestations = batch.map((i) => i.value);
    const priorityFeeMicroLamports = this.opts.priorityFee;
    const result =
      attestations.length === 1
        ? await this.sdk.solana.submitAttestation(attestations[0]!, { priorityFeeMicroLamports })
        : await this.sdk.solana.submitAttestations(attestations, { priorityFeeMicroLamports });
    return result.signature;
  }

  private async onBroadcastError(batch: Item<Attestation>[], err: unknown, sentAt: number): Promise<void> {
    if (err instanceof BatchTooLargeError) {
      this.maxBatch = Math.max(1, err.fits);
      this.queue.requeue(batch, Number.POSITIVE_INFINITY);
      return;
    }
    const name = errName(err);
    bump(this.stats.submitErrors, name);
    if (name === "FeedNotNewer") {
      this.stats.submit.staleRejected += batch.length;
      this.queue.rejectedStale(batch);
      return;
    }
    // A dropped send can still have landed. Check the feed before resending.
    if (await this.landedAnyway(batch)) {
      this.markExecuted(batch);
      this.markConfirmed(batch, sentAt);
      return;
    }
    this.stats.submit.failedTx++;
    this.stats.submit.givenUp += this.queue.requeue(batch, this.opts.maxSubmitAttempts);
  }

  private async pollStatus(
    signature: string,
    target: Commitment,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<SignatureStatus | "timeout"> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (signal?.aborted) return "timeout";
      try {
        const status = await this.readStatus(signature);
        if (status?.err) return status;
        if (status && reached(status.confirmationStatus, target)) return status;
      } catch {
        // A status RPC blip is not a failed transaction. Poll until the deadline.
      }
      await sleep(STATUS_POLL_MS, signal);
    }
    return "timeout";
  }

  private async readStatus(signature: string): Promise<SignatureStatus | null> {
    if (!this.statuses) return null;
    const { value } = await this.statuses.getSignatureStatuses([signature]);
    return value[0] ?? null;
  }

  /** Record confirmation latency without holding the submit lane. */
  private watchConfirmed(signature: string, batch: Item<Attestation>[], sentAt: number): void {
    const target = this.opts.commitment ?? "confirmed";
    if (target === "processed") {
      this.markConfirmed(batch, sentAt);
      return;
    }
    const job = this.pollStatus(signature, target, CONFIRM_TIMEOUT_MS, this.confirmAbort.signal).then(
      (status) => {
        if (status !== "timeout" && !status.err) this.markConfirmed(batch, sentAt);
      },
    );
    this.pendingConfirms.add(job);
    void job.finally(() => this.pendingConfirms.delete(job));
  }

  private async landedAnyway(batch: Item<Attestation>[]): Promise<boolean> {
    const newest = batch[batch.length - 1];
    if (!newest) return false;
    try {
      const feed = await this.sdk.solana.readFeed(
        newest.value.payload.sourceId,
        this.feed.signaturesRequired,
      );
      return feed !== null && Number(feed.timestamp.toString()) >= newest.ts;
    } catch {
      return false;
    }
  }

  /** The signature is processed: the feed account has moved, so the next batch may be sent. */
  private markExecuted(batch: Item<Attestation>[]): void {
    const now = Date.now();
    this.queue.landedBatch(batch);
    this.stats.submit.txOk++;
    this.stats.submit.landed += batch.length;
    this.stats.batchSize.add(batch.length);
    this.stats.landedRate.hit(now, batch.length);
  }

  /** The signature reached the configured commitment. */
  private markConfirmed(batch: Item<Attestation>[], sentAt: number): void {
    const now = Date.now();
    this.stats.confirmMs.add(now - sentAt);
    for (const i of batch) this.stats.onchainAgeMs.add(now - i.ts);
  }
}
