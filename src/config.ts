import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import "dotenv/config";
import type { AggregationConfig, APIConfig } from "@molpha/sdk";

/** One feed the pusher drives: a source, a quorum and a cadence. */
export interface FeedSpec {
  label: string;
  apiConfig: APIConfig;
  signaturesRequired: number;
  /** Target spacing between rounds, ms. 250 = 4 updates/s. */
  intervalMs: number;
  /** Decimals of the signed int256 (tolerance mode), for display. */
  decimals?: number;
}

interface FeedsFile {
  defaults?: {
    intervalMs?: number;
    signaturesRequired?: number;
    aggregation?: AggregationConfig | null;
  };
  feeds: Array<{
    label: string;
    apiConfig: APIConfig;
    signaturesRequired?: number;
    intervalMs?: number;
  }>;
}

export function expandHome(p: string): string {
  return p.startsWith("~") ? resolve(homedir(), p.slice(2)) : resolve(p);
}

export function loadFeeds(path = process.env.FEEDS_FILE ?? "config/feeds.json"): FeedSpec[] {
  const file = JSON.parse(readFileSync(expandHome(path), "utf8")) as FeedsFile;
  const d = file.defaults ?? {};
  if (!Array.isArray(file.feeds) || file.feeds.length === 0) {
    throw new Error(`${path}: "feeds" must be a non-empty array`);
  }
  const labels = new Set<string>();
  return file.feeds.map((f) => {
    if (labels.has(f.label)) throw new Error(`${path}: duplicate feed label ${f.label}`);
    labels.add(f.label);
    // A feed's own `aggregation` wins; `null` opts it out of the default (exact mode).
    const own = (f.apiConfig as { aggregation?: AggregationConfig | null }).aggregation;
    const aggregation = own === null ? undefined : own ?? d.aggregation ?? undefined;
    const apiConfig: APIConfig = { ...f.apiConfig };
    if (aggregation) apiConfig.aggregation = aggregation;
    else delete apiConfig.aggregation;
    const intervalMs = f.intervalMs ?? d.intervalMs ?? 250;
    const signaturesRequired = f.signaturesRequired ?? d.signaturesRequired ?? 3;
    if (intervalMs < 100) {
      // The gateway stamps rounds on a 100 ms grid and gives one consumer one round
      // per tick per feed; asking faster only produces 409s.
      throw new Error(`${f.label}: intervalMs ${intervalMs} is below the 100 ms round tick`);
    }
    return {
      label: f.label,
      apiConfig,
      signaturesRequired,
      intervalMs,
      decimals: aggregation?.numeric.decimals,
    };
  });
}

export type Commitment = "processed" | "confirmed" | "finalized";

export interface Env {
  rpcUrl: string;
  wsUrl?: string;
  keypairPath: string;
  gatewayUrl?: string;
  gatewayAuthority?: string;
  commitment: Commitment;
  priorityFee: number | "auto" | undefined;
}

export function loadEnv(): Env {
  const commitment = (process.env.COMMITMENT ?? "confirmed") as Commitment;
  if (!["processed", "confirmed", "finalized"].includes(commitment)) {
    throw new Error(`COMMITMENT must be processed | confirmed | finalized, got ${commitment}`);
  }
  const pf = (process.env.PRIORITY_FEE ?? "auto").trim();
  let priorityFee: Env["priorityFee"];
  if (pf === "auto") priorityFee = "auto";
  else if (pf === "" || pf === "0") priorityFee = undefined;
  else if (/^\d+$/.test(pf)) priorityFee = Number(pf);
  else throw new Error(`PRIORITY_FEE must be "auto", 0 or an integer (micro-lamports/CU), got ${pf}`);
  return {
    rpcUrl: process.env.RPC_URL ?? "https://api.devnet.solana.com",
    wsUrl: process.env.WS_URL || undefined,
    keypairPath: process.env.KEYPAIR_PATH ?? "~/.config/solana/id.json",
    gatewayUrl: process.env.GATEWAY_URL || undefined,
    gatewayAuthority: process.env.GATEWAY_AUTHORITY || undefined,
    commitment,
    priorityFee,
  };
}
