import { BorshAccountsCoder, web3 } from "@anchor-lang/core";
import {
  MOLPHA_IDL,
  deriveSourceId,
  feedPda,
  formatInt256Decimal,
} from "@molpha/sdk";
import type { Commitment, FeedSpec } from "./config.js";
import { Rate, Samples } from "./stats.js";

/**
 * Consumer-side view of the feeds: what a program reading the Feed accounts actually
 * sees. It needs no Molpha subscription and no gateway access, only an RPC websocket.
 *
 * For every account notification it records:
 *  - the on-chain update rate (distinct round timestamps observed per second);
 *  - the age of the value when the notification arrives (local clock minus the
 *    round's gateway timestamp; keep both clocks NTP-synced);
 *  - the spacing between consecutive observed updates, and gaps.
 *
 * Websocket notifications are per slot: several updates of one feed landing in the
 * same slot show up as one notification carrying the last of them. That is also what
 * any transaction in a later slot reads, so it is the honest consumer-side number.
 * The difference between `landed/s` on the pusher and `seen/s` here is exactly that.
 */

interface FeedDecoded {
  value: number[] | Uint8Array;
  timestamp: { toString(): string };
  signaturesRequired?: number;
  signatures_required?: number;
  registryVersion?: number;
  registry_version?: number;
}

export interface WatchStats {
  label: string;
  address: string;
  notifications: number;
  updates: number;
  lastValue?: string;
  lastTs?: number;
  ageMs: Samples;
  spacingMs: Samples;
  gaps: number;
  rate: Rate;
}

export interface Watcher {
  stats: WatchStats[];
  stop(): Promise<void>;
}

export function startWatch(
  connection: web3.Connection,
  feeds: FeedSpec[],
  submitter: web3.PublicKey,
  programId: string,
  commitment: Commitment,
): Watcher {
  const coder = new BorshAccountsCoder(MOLPHA_IDL);
  const subs: number[] = [];
  const stats: WatchStats[] = [];

  for (const feed of feeds) {
    const address = feedPda(
      deriveSourceId(feed.apiConfig),
      feed.signaturesRequired,
      submitter,
      programId,
    ).toString();
    const s: WatchStats = {
      label: feed.label,
      address,
      notifications: 0,
      updates: 0,
      ageMs: new Samples(),
      spacingMs: new Samples(),
      gaps: 0,
      rate: new Rate(),
    };
    stats.push(s);
    const id = connection.onAccountChange(
      new web3.PublicKey(address),
      (info) => {
        const now = Date.now();
        s.notifications++;
        let decoded: FeedDecoded;
        try {
          decoded = coder.decode("Feed", info.data) as FeedDecoded;
        } catch {
          return;
        }
        const ts = Number(decoded.timestamp.toString());
        if (s.lastTs !== undefined && ts <= s.lastTs) return;
        if (s.lastTs !== undefined) {
          const spacing = ts - s.lastTs;
          s.spacingMs.add(spacing);
          if (spacing > 2 * feed.intervalMs) s.gaps++;
        }
        s.updates++;
        s.rate.hit(now);
        s.ageMs.add(now - ts);
        s.lastTs = ts;
        s.lastValue =
          feed.decimals !== undefined
            ? formatInt256Decimal(Uint8Array.from(decoded.value), feed.decimals)
            : Buffer.from(Uint8Array.from(decoded.value)).toString("hex");
      },
      { commitment },
    );
    subs.push(id);
  }

  return {
    stats,
    async stop() {
      await Promise.allSettled(subs.map((id) => connection.removeAccountChangeListener(id)));
    },
  };
}
