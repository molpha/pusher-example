/**
 * Per-feed submit queue. Pure logic, no I/O, so the ordering rules are unit-testable.
 *
 * The program refuses an update whose timestamp is not newer than the feed's
 * (`FeedNotNewer`), so everything here is about keeping submissions of one feed in
 * timestamp order:
 *
 *  - rounds finish out of order (one round can take longer than the next), so the
 *    queue sorts by the gateway-assigned timestamp;
 *  - only one transaction per feed is in flight; while it confirms, new rounds pile
 *    up and go out together in the next transaction (adaptive batching), applied
 *    oldest first inside one atomic transaction;
 *  - a round that completes after a newer one was already sent can never land and
 *    is dropped as `late` instead of wasting a transaction.
 */

export interface Item<T> {
  ts: number;
  receivedAt: number;
  attempts: number;
  value: T;
}

export type DropReason = "late" | "expired" | "backlog" | "superseded" | "duplicate";

export interface QueueOptions {
  /** "all": push every update, in order. "latest": push only the newest, skip the rest. */
  mode: "all" | "latest";
  /** An update older than this (by its round timestamp) is no longer worth a transaction. */
  maxAgeMs: number;
  /** Most queued updates; beyond it the oldest are dropped. */
  maxBacklog: number;
}

export class SubmitQueue<T> {
  private items: Item<T>[] = [];
  /** Newest timestamp sent in a transaction (in flight or landed). */
  private highWater = 0;
  /** Newest timestamp known to be on-chain. */
  private landed = 0;
  readonly drops: Record<DropReason, number> = {
    late: 0,
    expired: 0,
    backlog: 0,
    superseded: 0,
    duplicate: 0,
  };

  constructor(private readonly opts: QueueOptions) {}

  get length(): number {
    return this.items.length;
  }

  get newestLanded(): number {
    return this.landed;
  }

  add(ts: number, value: T, now = Date.now()): boolean {
    if (ts <= this.highWater) {
      this.drops.late++;
      return false;
    }
    if (this.items.some((i) => i.ts === ts)) {
      this.drops.duplicate++;
      return false;
    }
    const item: Item<T> = { ts, receivedAt: now, attempts: 0, value };
    let i = this.items.length;
    while (i > 0 && this.items[i - 1]!.ts > ts) i--;
    this.items.splice(i, 0, item);
    return true;
  }

  /**
   * Take the next batch to send (oldest first, at most `maxBatch`), after dropping
   * what is too old, superseded, or over the backlog cap. Marks the batch in flight.
   */
  take(maxBatch: number, now = Date.now()): Item<T>[] {
    const { maxAgeMs, maxBacklog, mode } = this.opts;
    const fresh = this.items.filter((i) => now - i.ts <= maxAgeMs);
    this.drops.expired += this.items.length - fresh.length;
    this.items = fresh;
    if (mode === "latest" && this.items.length > 1) {
      this.drops.superseded += this.items.length - 1;
      this.items = this.items.slice(-1);
    }
    if (this.items.length > maxBacklog) {
      const over = this.items.length - maxBacklog;
      this.drops.backlog += over;
      this.items = this.items.slice(over);
    }
    const batch = this.items.slice(0, Math.max(1, maxBatch));
    this.items = this.items.slice(batch.length);
    const newest = batch[batch.length - 1];
    if (newest) this.highWater = newest.ts;
    return batch;
  }

  /** The batch landed on-chain. */
  landedBatch(batch: Item<T>[]): void {
    const newest = batch[batch.length - 1];
    if (newest && newest.ts > this.landed) this.landed = newest.ts;
  }

  /**
   * The batch was refused because a newer update of the feed is already on-chain
   * (`FeedNotNewer`). Nothing to retry; the high-water mark stays.
   */
  rejectedStale(_batch: Item<T>[]): void {}

  /**
   * The batch failed for a transient reason (RPC error, blockhash expiry, dropped
   * transaction). Nothing in it landed, so the high-water mark falls back to the newest
   * landed timestamp and the items go back in the queue, unless retried too often.
   * Returns how many were given up on.
   */
  requeue(batch: Item<T>[], maxAttempts: number): number {
    this.highWater = this.landed;
    let givenUp = 0;
    for (const item of batch) {
      item.attempts++;
      if (item.attempts >= maxAttempts) {
        givenUp++;
        continue;
      }
      if (this.items.some((i) => i.ts === item.ts)) continue;
      let i = this.items.length;
      while (i > 0 && this.items[i - 1]!.ts > item.ts) i--;
      this.items.splice(i, 0, item);
    }
    return givenUp;
  }
}
