import type { FeedPusher } from "./pusher.js";
import { fmtMs, round } from "./stats.js";
import type { WatchStats } from "./watch.js";

const pad = (s: unknown, n: number) => String(s).padStart(n);
const padEnd = (s: unknown, n: number) => String(s).padEnd(n);

export function renderPush(pushers: FeedPusher[], elapsedS: number, noSubmit: boolean): string {
  const head =
    padEnd("feed", 10) +
    pad("value", 16) +
    pad("rounds ok/fail", 16) +
    pad("rnd/s", 7) +
    pad("round p50/p95", 15) +
    (noSubmit
      ? ""
      : pad("landed/s", 10) +
        pad("batch", 7) +
        pad("confirm p50/p95", 17) +
        pad("age@chain p50/p95", 19) +
        pad("queue", 7) +
        pad("lost", 6));
  const rows = pushers.map((p) => {
    const s = p.stats;
    const lost =
      s.submit.staleRejected +
      s.submit.givenUp +
      p.drops.late +
      p.drops.expired +
      p.drops.backlog;
    return (
      padEnd(s.label, 10) +
      pad(s.lastValue ?? "-", 16) +
      pad(`${s.rounds.ok}/${s.rounds.failed}`, 16) +
      pad(round(s.roundRate.perSecond()), 7) +
      pad(`${fmtMs(s.roundMs.pct(50))}/${fmtMs(s.roundMs.pct(95))}`, 15) +
      (noSubmit
        ? ""
        : pad(round(s.landedRate.perSecond()), 10) +
          pad(round(s.batchSize.mean()), 7) +
          pad(`${fmtMs(s.confirmMs.pct(50))}/${fmtMs(s.confirmMs.pct(95))}`, 17) +
          pad(`${fmtMs(s.onchainAgeMs.pct(50))}/${fmtMs(s.onchainAgeMs.pct(95))}`, 19) +
          pad(p.backlog, 7) +
          pad(lost, 6))
    );
  });
  const errs = pushers
    .flatMap((p) =>
      [
        ...Object.entries(p.stats.roundErrors).map(([k, v]) => `${p.stats.label} round ${k}×${v}`),
        ...Object.entries(p.stats.submitErrors).map(([k, v]) => `${p.stats.label} submit ${k}×${v}`),
      ],
    )
    .slice(0, 8);
  return [
    `elapsed ${Math.round(elapsedS)}s   (rates over the last 10 s; latencies in ms)`,
    head,
    ...rows,
    errs.length ? `errors: ${errs.join(" | ")}` : "",
  ].join("\n");
}

export function renderWatch(stats: WatchStats[], elapsedS: number): string {
  const head =
    padEnd("feed", 10) +
    pad("value", 16) +
    pad("seen", 8) +
    pad("seen/s", 8) +
    pad("spacing p50/p95", 17) +
    pad("age p50/p95/max", 19) +
    pad("gaps", 6);
  const rows = stats.map(
    (s) =>
      padEnd(s.label, 10) +
      pad(s.lastValue ?? "-", 16) +
      pad(s.updates, 8) +
      pad(round(s.rate.perSecond()), 8) +
      pad(`${fmtMs(s.spacingMs.pct(50))}/${fmtMs(s.spacingMs.pct(95))}`, 17) +
      pad(`${fmtMs(s.ageMs.pct(50))}/${fmtMs(s.ageMs.pct(95))}/${fmtMs(s.ageMs.max)}`, 19) +
      pad(s.gaps, 6),
  );
  return [
    `elapsed ${Math.round(elapsedS)}s   age = local clock − round timestamp at notification (ms)`,
    head,
    ...rows,
  ].join("\n");
}

export function pushReport(pushers: FeedPusher[], elapsedS: number) {
  return pushers.map((p) => {
    const s = p.stats;
    return {
      label: s.label,
      sourceId: s.sourceId,
      lastValue: s.lastValue,
      rounds: s.rounds,
      roundErrors: s.roundErrors,
      roundsPerSecond: round(s.rounds.ok / elapsedS, 2),
      roundMs: s.roundMs.summary(),
      signedAgeMs: s.signedAgeMs.summary(),
      submit: s.submit,
      submitErrors: s.submitErrors,
      drops: { ...p.drops },
      landedPerSecond: round(s.submit.landed / elapsedS, 2),
      txPerSecond: round(s.submit.txOk / elapsedS, 2),
      batchSize: s.batchSize.summary(),
      confirmMs: s.confirmMs.summary(),
      onchainAgeMs: s.onchainAgeMs.summary(),
    };
  });
}

export function watchReport(stats: WatchStats[], elapsedS: number) {
  return stats.map((s) => ({
    label: s.label,
    address: s.address,
    notifications: s.notifications,
    updates: s.updates,
    updatesPerSecond: round(s.updates / elapsedS, 2),
    spacingMs: s.spacingMs.summary(),
    ageMs: s.ageMs.summary(),
    gaps: s.gaps,
    lastValue: s.lastValue,
  }));
}
