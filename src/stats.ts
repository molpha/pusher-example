/** Bounded sample window with percentiles. Keeps the most recent `cap` values. */
export class Samples {
  private buf: number[] = [];
  private next = 0;
  total = 0;
  sum = 0;
  max = 0;

  constructor(private readonly cap = 4096) {}

  add(v: number): void {
    if (!Number.isFinite(v)) return;
    this.total++;
    this.sum += v;
    if (v > this.max) this.max = v;
    if (this.buf.length < this.cap) this.buf.push(v);
    else {
      this.buf[this.next] = v;
      this.next = (this.next + 1) % this.cap;
    }
  }

  /** Percentile over the window, `p` in [0, 100]. NaN when empty. */
  pct(p: number): number {
    if (this.buf.length === 0) return NaN;
    const s = [...this.buf].sort((a, b) => a - b);
    const i = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
    return s[i]!;
  }

  mean(): number {
    return this.total === 0 ? NaN : this.sum / this.total;
  }

  summary() {
    return {
      count: this.total,
      p50: round(this.pct(50)),
      p95: round(this.pct(95)),
      p99: round(this.pct(99)),
      max: round(this.max),
      mean: round(this.mean()),
    };
  }
}

/** Counts events in a sliding time window, for "per second" rates. */
export class Rate {
  private stamps: number[] = [];
  constructor(private readonly windowMs = 10_000) {}

  hit(now = Date.now(), n = 1): void {
    for (let i = 0; i < n; i++) this.stamps.push(now);
    this.trim(now);
  }

  perSecond(now = Date.now()): number {
    this.trim(now);
    return (this.stamps.length * 1000) / this.windowMs;
  }

  private trim(now: number): void {
    const cut = now - this.windowMs;
    let i = 0;
    while (i < this.stamps.length && this.stamps[i]! < cut) i++;
    if (i > 0) this.stamps.splice(0, i);
  }
}

export function round(v: number, digits = 1): number {
  if (!Number.isFinite(v)) return NaN;
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

export function fmtMs(v: number): string {
  return Number.isFinite(v) ? `${Math.round(v)}` : "-";
}
