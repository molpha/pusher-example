import { mkdirSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { web3 } from "@anchor-lang/core";
import {
  MOLPHA_SDK_PROFILE,
  PlanType,
  deriveSourceId,
  deriveSourceIdString,
  feedPda,
  formatInt256Decimal,
} from "@molpha/sdk";
import { loadEnv, loadFeeds, type FeedSpec } from "./config.js";
import { ContextCache, FeedPusher, RoundBudget, type PusherOptions } from "./pusher.js";
import { pushReport, renderPush, renderWatch, watchReport } from "./report.js";
import { createMolpha } from "./sdk.js";
import { startWatch } from "./watch.js";

const LAMPORTS_PER_SOL = 1_000_000_000;
const BASE_FEE_LAMPORTS = 5_000;

const USAGE = `molpha-pusher — high-frequency push feeds on Molpha

  npm run info                      payer, subscription, quota burn, feed addresses
  npm run probe                     one signed round per feed, no submit
  npm run push  -- [options]        run the pusher
  npm run watch -- [options]        consumer view of the feeds (no subscription needed)

push options
  --duration <s>        run time in seconds (default 120)
  --mode <all|latest>   push every update in order (default), or only the newest
  --max-rounds <n>      stop starting rounds after n rounds in total (quota guard)
  --no-submit           request rounds only; measures the signing path, spends no SOL
  --max-age-ms <ms>     drop an update older than this instead of submitting it (default 3000)
  --max-backlog <n>     most queued updates per feed (default 12)
  --inflight <n>        most concurrent rounds per feed (default 3)
  --round-timeout <ms>  per-round gateway timeout (default 5000)
  --interval <ms>       override every feed's interval
  --feeds <a,b>         only these feed labels

watch options
  --duration <s>        run time in seconds (default: until Ctrl-C)
  --submitter <pubkey>  whose feeds to watch (default: this keypair)
  --feeds <a,b>         only these feed labels
`;

function selectFeeds(all: FeedSpec[], only?: string): FeedSpec[] {
  if (!only) return all;
  const want = new Set(only.split(",").map((s) => s.trim()));
  const feeds = all.filter((f) => want.has(f.label));
  if (feeds.length === 0) throw new Error(`--feeds matched none of: ${all.map((f) => f.label).join(", ")}`);
  return feeds;
}

function writeReport(kind: string, data: unknown): string {
  mkdirSync("reports", { recursive: true });
  const path = `reports/${kind}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  writeFileSync(path, JSON.stringify(data, null, 2));
  return path;
}

function live(render: () => string, everyMs = 2000): () => void {
  const tty = process.stdout.isTTY;
  const draw = () => {
    if (tty) process.stdout.write("\x1b[2J\x1b[H");
    console.log(render() + (tty ? "" : "\n"));
  };
  const t = setInterval(draw, everyMs);
  return () => {
    clearInterval(t);
    draw();
  };
}

function untilSignalOr(ms?: number): Promise<void> {
  return new Promise((resolve) => {
    const t = ms ? setTimeout(resolve, ms) : undefined;
    const stop = () => {
      if (t) clearTimeout(t);
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

async function info() {
  const env = loadEnv();
  const feeds = loadFeeds();
  const { sdk, connection, payer } = createMolpha(env);
  const programId = sdk.solana.programId.toString();
  const balance = await connection.getBalance(payer);
  console.log(`sdk profile     ${MOLPHA_SDK_PROFILE}`);
  console.log(`program         ${programId}`);
  console.log(`gateway         ${sdk.gateway.endpointUrls().join(", ")}`);
  console.log(`rpc             ${env.rpcUrl}  (commitment ${env.commitment})`);
  console.log(`payer           ${payer.toBase58()}  ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL`);

  const reg = await sdk.solana.getRegistrySelectionConfig();
  console.log(
    `registry        v${reg.registryVersion}, ${reg.nodeCount} nodes, redundancy buffer ${reg.redundancyBuffer}`,
  );

  const sub = await sdk.solana.readSubscription();
  const roundsPerSecond = feeds.reduce((n, f) => n + 1000 / f.intervalMs, 0);
  if (!sub) {
    console.log("subscription    none — subscribe first (see README) or use a delegate keypair");
  } else {
    const plan = await sdk.solana.readPlan(sub.planType);
    const validUntil = new Date(Number(sub.validUntil) * 1000).toISOString();
    console.log(
      `subscription    ${PlanType[sub.planType]}, valid until ${validUntil}, ` +
        `${sub.maxRounds} rounds per term, max ${sub.maxSigners} signers`,
    );
    if (plan) {
      console.log(
        `plan price      ${Number(plan.subscriptionPrice) / 1e6} USDC per term`,
      );
    }
    const hours = Number(sub.maxRounds) / roundsPerSecond / 3600;
    console.log(
      `quota burn      ${roundsPerSecond} rounds/s at the configured cadence → a full term's quota ` +
        `lasts ~${hours < 1 ? `${Math.round(hours * 60)} min` : `${hours.toFixed(1)} h`} of continuous pushing ` +
        `(the gateway counts usage off-chain; this assumes an unused term)`,
    );
  }

  const txPerSecond = roundsPerSecond / 2; // ~2 updates per transaction with adaptive batching
  console.log(
    `fee floor       ~${((txPerSecond * BASE_FEE_LAMPORTS * 86_400) / LAMPORTS_PER_SOL).toFixed(2)} SOL/day ` +
      `in base fees at ~2 updates/tx, before priority fees`,
  );

  console.log("\nfeeds (submitter = this payer)");
  for (const f of feeds) {
    const pda = feedPda(deriveSourceId(f.apiConfig), f.signaturesRequired, payer, programId);
    const state = await sdk.solana.readFeed(deriveSourceIdString(f.apiConfig), f.signaturesRequired);
    const last = state
      ? `${f.decimals !== undefined ? formatInt256Decimal(Uint8Array.from(state.value), f.decimals) : "set"} @ ${new Date(Number(state.timestamp.toString())).toISOString()}`
      : "not created yet (first submit creates it)";
    console.log(
      `  ${f.label.padEnd(10)} q=${f.signaturesRequired} every ${f.intervalMs}ms  ${pda}  ${last}`,
    );
  }
}

async function probe() {
  const env = loadEnv();
  const feeds = loadFeeds();
  const { sdk } = createMolpha(env);
  console.log(`probing ${feeds.length} feeds via ${sdk.gateway.endpointUrls().join(", ")} (one round each, no submit)\n`);
  const context = await sdk.gateway.prepareContext();
  let failed = 0;
  for (const f of feeds) {
    const t0 = Date.now();
    try {
      const att = await sdk.gateway.requestSignedData({
        apiConfig: f.apiConfig,
        signaturesRequired: f.signaturesRequired,
        context,
      });
      const value =
        f.decimals !== undefined ? formatInt256Decimal(att.payload.value, f.decimals) : att.value;
      console.log(
        `  ok    ${f.label.padEnd(10)} ${value.padStart(16)}  ${Date.now() - t0} ms  ` +
          `ts ${att.payload.timestamp}  source ${att.payload.sourceId.slice(0, 16)}…`,
      );
    } catch (err) {
      failed++;
      console.log(`  FAIL  ${f.label.padEnd(10)} ${(err as Error).message.split("\n")[0]}`);
    }
  }
  if (failed) {
    console.log(
      `\n${failed} feed(s) failed. Typical causes: the source is geo-blocked from the node hosts, ` +
        `the responseParser does not match the response, or the nodes' observations ` +
        `differ by more than maxDeviationBps.`,
    );
    process.exitCode = 1;
  }
}

async function push(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      duration: { type: "string", default: "120" },
      mode: { type: "string", default: "all" },
      "max-rounds": { type: "string" },
      "no-submit": { type: "boolean", default: false },
      "max-age-ms": { type: "string", default: "3000" },
      "max-backlog": { type: "string", default: "12" },
      inflight: { type: "string", default: "3" },
      "round-timeout": { type: "string", default: "5000" },
      interval: { type: "string" },
      feeds: { type: "string" },
    },
  });
  if (values.mode !== "all" && values.mode !== "latest") throw new Error("--mode must be all or latest");
  const env = loadEnv();
  let feeds = selectFeeds(loadFeeds(), values.feeds);
  if (values.interval) {
    const ms = Number(values.interval);
    if (!(ms >= 100)) throw new Error("--interval must be at least 100 ms (the round tick)");
    feeds = feeds.map((f) => ({ ...f, intervalMs: ms }));
  }
  const opts: PusherOptions = {
    mode: values.mode,
    maxAgeMs: Number(values["max-age-ms"]),
    maxBacklog: Number(values["max-backlog"]),
    maxInflightRounds: Number(values.inflight),
    roundTimeoutMs: Number(values["round-timeout"]),
    maxSubmitAttempts: 3,
    priorityFee: env.priorityFee,
    noSubmit: values["no-submit"],
    maxRounds: values["max-rounds"] ? Number(values["max-rounds"]) : undefined,
    commitment: env.commitment,
  };
  const durationMs = Number(values.duration) * 1000;

  const { sdk, connection, payer } = createMolpha(env);
  const ctx = new ContextCache(sdk);
  const budget = new RoundBudget(opts.maxRounds);
  await ctx.get(); // fail fast on a bad RPC, program or gateway before the clock starts
  const balanceBefore = await connection.getBalance(payer);

  const pushers = feeds.map((f) => new FeedPusher(f, sdk, ctx, budget, opts, connection));
  const startedAt = Date.now() + 200;
  // Stagger feeds across one interval so their rounds do not all hit the gateway in the same tick.
  pushers.forEach((p, i) =>
    p.start(startedAt + Math.floor((i * p.feed.intervalMs) / pushers.length)),
  );

  const stopDisplay = live(() => renderPush(pushers, (Date.now() - startedAt) / 1000, opts.noSubmit));
  await untilSignalOr(durationMs);
  const stoppedAt = Date.now();
  await Promise.all(pushers.map((p) => p.stop()));
  stopDisplay();

  const elapsedS = (stoppedAt - startedAt) / 1000;
  const balanceAfter = await connection.getBalance(payer).catch(() => balanceBefore);
  const feedsReport = pushReport(pushers, elapsedS);
  const txTotal = feedsReport.reduce((n, f) => n + f.submit.txOk + f.submit.staleRejected, 0);
  const report = {
    kind: "push",
    startedAt: new Date(startedAt).toISOString(),
    elapsedSeconds: Math.round(elapsedS),
    sdkProfile: MOLPHA_SDK_PROFILE,
    programId: sdk.solana.programId.toString(),
    gateway: sdk.gateway.endpointUrls(),
    registryVersion: ctx.registryVersion,
    rpc: new URL(env.rpcUrl).host,
    commitment: env.commitment,
    priorityFee: env.priorityFee ?? 0,
    options: opts,
    payer: payer.toBase58(),
    totals: {
      roundsStarted: budget.started,
      roundsOk: feedsReport.reduce((n, f) => n + f.rounds.ok, 0),
      landed: feedsReport.reduce((n, f) => n + f.submit.landed, 0),
      transactions: txTotal,
      // Balance delta includes rent for feed accounts created by this run.
      solSpent: (balanceBefore - balanceAfter) / LAMPORTS_PER_SOL,
      baseFeeFloorSol: (txTotal * BASE_FEE_LAMPORTS) / LAMPORTS_PER_SOL,
    },
    feeds: feedsReport,
  };
  console.log(
    `\n${report.totals.roundsOk} signed rounds, ${report.totals.landed} updates landed in ` +
      `${txTotal} transactions over ${report.elapsedSeconds}s; ${report.totals.solSpent.toFixed(5)} SOL spent`,
  );
  console.log(`report: ${writeReport("push", report)}`);
  process.exit(0);
}

async function watch(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      duration: { type: "string" },
      submitter: { type: "string" },
      feeds: { type: "string" },
    },
  });
  const env = loadEnv();
  const feeds = selectFeeds(loadFeeds(), values.feeds);
  const connection = new web3.Connection(env.rpcUrl, { commitment: env.commitment, wsEndpoint: env.wsUrl });
  let submitter: web3.PublicKey;
  let programId: string;
  if (values.submitter) {
    submitter = new web3.PublicKey(values.submitter);
    const { MOLPHA_PROGRAM_ADDRESS } = await import("@molpha/sdk");
    programId = MOLPHA_PROGRAM_ADDRESS;
  } else {
    const m = createMolpha(env);
    submitter = m.payer;
    programId = m.sdk.solana.programId.toString();
  }
  const watcher = startWatch(connection, feeds, submitter, programId, env.commitment);
  const startedAt = Date.now();
  const stopDisplay = live(() => renderWatch(watcher.stats, (Date.now() - startedAt) / 1000), 1000);
  await untilSignalOr(values.duration ? Number(values.duration) * 1000 : undefined);
  stopDisplay();
  await watcher.stop();
  const elapsedS = (Date.now() - startedAt) / 1000;
  const path = writeReport("watch", {
    kind: "watch",
    startedAt: new Date(startedAt).toISOString(),
    elapsedSeconds: Math.round(elapsedS),
    rpc: new URL(env.rpcUrl).host,
    commitment: env.commitment,
    submitter: submitter.toBase58(),
    programId,
    feeds: watchReport(watcher.stats, elapsedS),
  });
  console.log(`report: ${path}`);
  process.exit(0);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "info":
      return info();
    case "probe":
      return probe();
    case "push":
      return push(rest);
    case "watch":
      return watch(rest);
    default:
      console.log(USAGE);
      process.exitCode = cmd ? 1 : 0;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
