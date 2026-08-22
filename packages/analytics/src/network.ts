/**
 * Network measurement maths.
 *
 * Everything here replaces something that was previously either a mean, a
 * guess, or Math.random(). The distinction that runs through all of it: an
 * average hides exactly the behaviour an operator needs to see. Mean latency
 * looks fine while one request in twenty times out; mean loss looks fine while
 * the link drops forty packets in a row twice an hour.
 */

/**
 * Percentile by nearest-rank.
 *
 * p95 and p99 are what matter for latency. The mean is dominated by the
 * majority of fast samples, so a link can have an unusable tail and a
 * perfectly healthy average.
 */
export function percentile(values: readonly number[], p: number): number {
  const clean = values.filter((v) => Number.isFinite(v));
  if (clean.length === 0) return 0;
  if (p <= 0) return Math.min(...clean);
  if (p >= 100) return Math.max(...clean);
  const sorted = [...clean].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(rank, sorted.length) - 1] as number;
}

export interface LatencyStats {
  count: number;
  min: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  /** RFC 3550 interarrival jitter. */
  jitter: number;
}

/**
 * Interarrival jitter as defined by RFC 3550 section 6.4.1:
 *
 *   J += (|D(i-1, i)| - J) / 16
 *
 * This is the definition every network tool uses, so a number produced here is
 * comparable with one from anywhere else. The previous implementation reported
 * the difference between the last two samples, which is not jitter - it is one
 * sample of the quantity jitter smooths.
 */
export function rfc3550Jitter(latencies: readonly number[]): number {
  if (latencies.length < 2) return 0;
  let jitter = 0;
  for (let i = 1; i < latencies.length; i++) {
    const d = Math.abs((latencies[i] as number) - (latencies[i - 1] as number));
    jitter += (d - jitter) / 16;
  }
  return Math.round(jitter * 1000) / 1000;
}

export function latencyStats(values: readonly number[]): LatencyStats {
  const clean = values.filter((v) => Number.isFinite(v));
  if (clean.length === 0) {
    return { count: 0, min: 0, mean: 0, p50: 0, p95: 0, p99: 0, max: 0, jitter: 0 };
  }
  const sum = clean.reduce((a, b) => a + b, 0);
  const round = (n: number) => Math.round(n * 1000) / 1000;
  return {
    count: clean.length,
    min: round(Math.min(...clean)),
    mean: round(sum / clean.length),
    p50: round(percentile(clean, 50)),
    p95: round(percentile(clean, 95)),
    p99: round(percentile(clean, 99)),
    max: round(Math.max(...clean)),
    jitter: rfc3550Jitter(clean),
  };
}

export interface LossAnalysis {
  /** Fraction of probes lost, 0..1. */
  lossRate: number;
  totalProbes: number;
  lostProbes: number;
  /** Longest run of consecutive losses. */
  longestBurst: number;
  /** Runs of two or more consecutive losses. */
  burstCount: number;
  /**
   * True when loss is concentrated rather than scattered.
   *
   * Worth separating: 2% scattered loss is background noise on any real link,
   * while 2% arriving as one 40-packet burst is an outage users noticed. The
   * average is identical.
   */
  bursty: boolean;
}

/** `probes` is ordered oldest to newest; true means the probe was lost. */
export function analyseLoss(probes: readonly boolean[]): LossAnalysis {
  const total = probes.length;
  if (total === 0) {
    return {
      lossRate: 0,
      totalProbes: 0,
      lostProbes: 0,
      longestBurst: 0,
      burstCount: 0,
      bursty: false,
    };
  }

  let lost = 0;
  let longest = 0;
  let bursts = 0;
  let run = 0;

  for (const isLost of probes) {
    if (isLost) {
      lost += 1;
      run += 1;
      if (run > longest) longest = run;
      if (run === 2) bursts += 1;
    } else {
      run = 0;
    }
  }

  return {
    lossRate: lost / total,
    totalProbes: total,
    lostProbes: lost,
    longestBurst: longest,
    burstCount: bursts,
    // A burst of three or more, or over half the loss concentrated in the
    // single longest run, means this is not scattered noise.
    bursty: longest >= 3 || (lost > 0 && longest / lost > 0.5 && longest >= 2),
  };
}

export interface SaturationForecast {
  /** Utilisation as a fraction, 0..1. */
  current: number;
  /** Change per second, from a least-squares fit. */
  trendPerSecond: number;
  /** Seconds until the threshold is reached, or null if not trending there. */
  secondsToSaturation: number | null;
  /** Enough samples and a clear enough trend to be worth acting on. */
  confident: boolean;
}

/**
 * Projects when a rising utilisation will hit a threshold.
 *
 * A linear fit is deliberate. Anything fancier invites a forecast nobody can
 * explain, and for "this link is filling up, you have about twenty minutes" a
 * straight line is both sufficient and defensible.
 */
export function forecastSaturation(
  samples: readonly { at: number; utilisation: number }[],
  threshold = 0.9,
): SaturationForecast {
  const pts = samples.filter((s) => Number.isFinite(s.utilisation) && Number.isFinite(s.at));
  const current = pts.length ? (pts[pts.length - 1] as { utilisation: number }).utilisation : 0;

  if (pts.length < 5) {
    return { current, trendPerSecond: 0, secondsToSaturation: null, confident: false };
  }

  // Least squares over seconds since the first sample.
  const t0 = (pts[0] as { at: number }).at;
  const xs = pts.map((p) => (p.at - t0) / 1000);
  const ys = pts.map((p) => p.utilisation);
  const n = xs.length;
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;

  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const dx = (xs[i] as number) - meanX;
    num += dx * ((ys[i] as number) - meanY);
    den += dx * dx;
  }
  const slope = den === 0 ? 0 : num / den;

  if (slope <= 0 || current >= threshold) {
    return {
      current,
      trendPerSecond: slope,
      secondsToSaturation: current >= threshold ? 0 : null,
      confident: n >= 10,
    };
  }

  return {
    current,
    trendPerSecond: slope,
    secondsToSaturation: Math.round((threshold - current) / slope),
    confident: n >= 10,
  };
}

/**
 * Counts events in a sliding time window, per key.
 *
 * The basis of rate-based detection: "five failed logins" means nothing
 * without a window, and "five failed logins in thirty seconds from one source"
 * is an actionable finding. Bounded by key count, because the keys come from
 * network input.
 */
export class SlidingWindowCounter {
  private readonly windowMs: number;
  private readonly maxKeys: number;
  private readonly events = new Map<string, number[]>();

  constructor(windowMs = 60_000, maxKeys = 1000) {
    this.windowMs = windowMs;
    this.maxKeys = maxKeys;
  }

  /** Records an event and returns the current count for that key. */
  record(key: string, now: number = Date.now()): number {
    let times = this.events.get(key);
    if (!times) {
      if (this.events.size >= this.maxKeys) {
        const oldest = this.events.keys().next().value as string | undefined;
        if (oldest !== undefined) this.events.delete(oldest);
      }
      times = [];
      this.events.set(key, times);
    }
    times.push(now);
    return this.countFor(key, now);
  }

  countFor(key: string, now: number = Date.now()): number {
    const times = this.events.get(key);
    if (!times) return 0;
    const cutoff = now - this.windowMs;
    let i = 0;
    while (i < times.length && (times[i] as number) < cutoff) i++;
    if (i > 0) times.splice(0, i);
    if (times.length === 0) this.events.delete(key);
    return times.length;
  }

  /** Total across every key. */
  total(now: number = Date.now()): number {
    let sum = 0;
    for (const key of [...this.events.keys()]) sum += this.countFor(key, now);
    return sum;
  }

  /** Keys at or above a count, busiest first. */
  keysAtOrAbove(
    threshold: number,
    now: number = Date.now(),
  ): Array<{ key: string; count: number }> {
    const out: Array<{ key: string; count: number }> = [];
    for (const key of [...this.events.keys()]) {
      const count = this.countFor(key, now);
      if (count >= threshold) out.push({ key, count });
    }
    return out.sort((a, b) => b.count - a.count);
  }

  get keyCount(): number {
    return this.events.size;
  }
  reset(): void {
    this.events.clear();
  }
}

export interface PortScanVerdict {
  detected: boolean;
  source: string;
  distinctPorts: number;
  windowMs: number;
}

/**
 * Port-scan detection: one source touching many distinct ports quickly.
 *
 * Distinct ports rather than connection count is the point - a busy client
 * opening two hundred connections to port 443 is normal traffic, while twenty
 * connections across twenty ports is a scan. Counting connections alone
 * flags the first and misses the second.
 */
export class PortScanDetector {
  private readonly windowMs: number;
  private readonly threshold: number;
  private readonly maxSources: number;
  private readonly seen = new Map<string, Map<number, number>>();

  constructor({ windowMs = 60_000, distinctPortThreshold = 15, maxSources = 1000 } = {}) {
    this.windowMs = windowMs;
    this.threshold = distinctPortThreshold;
    this.maxSources = maxSources;
  }

  record(source: string, port: number, now: number = Date.now()): PortScanVerdict {
    let ports = this.seen.get(source);
    if (!ports) {
      if (this.seen.size >= this.maxSources) {
        const oldest = this.seen.keys().next().value as string | undefined;
        if (oldest !== undefined) this.seen.delete(oldest);
      }
      ports = new Map();
      this.seen.set(source, ports);
    }
    ports.set(port, now);

    const cutoff = now - this.windowMs;
    for (const [p, t] of ports) if (t < cutoff) ports.delete(p);

    return {
      detected: ports.size >= this.threshold,
      source,
      distinctPorts: ports.size,
      windowMs: this.windowMs,
    };
  }

  reset(): void {
    this.seen.clear();
  }
}
