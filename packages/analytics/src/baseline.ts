/**
 * Statistical baselining.
 *
 * A fixed threshold is the crudest possible anomaly detector. "Alert when CPU
 * exceeds 80" is wrong in both directions on the same device: a router that
 * normally idles at 20% is in trouble at 60 and nobody is told, while one that
 * normally runs at 78 pages somebody every afternoon for behaving normally.
 *
 * What actually distinguishes a monitoring system worth running is knowing what
 * normal looks like for each specific thing it watches, and saying something
 * when reality departs from it.
 *
 * Two choices here matter:
 *
 * EWMA rather than a simple moving average, because it needs O(1) memory per
 * series and weights recent behaviour more heavily without a window edge that
 * makes old samples fall off a cliff.
 *
 * MAD rather than standard deviation, because standard deviation is computed
 * from the very outliers it is supposed to detect. One 100% CPU spike inflates
 * sigma enough to hide the next three. Median absolute deviation is robust:
 * roughly half the samples must be anomalous before it is meaningfully skewed.
 */

/** Scales MAD to be comparable with a standard deviation on normal data. */
const MAD_TO_SIGMA = 1.4826;

export interface EwmaOptions {
  /**
   * Smoothing factor, 0..1. Higher adapts faster and tolerates more noise.
   * 0.1 gives roughly a 20-sample memory, which at a 30s poll is ten minutes.
   */
  alpha?: number;
  /** Samples required before the baseline is treated as usable. */
  warmupSamples?: number;
}

/**
 * Exponentially weighted moving average and variance.
 *
 * Reports `ready` only after warmup: a baseline built from two samples will
 * call the third one anomalous, and a monitoring system that cries wolf for
 * its first five minutes after every restart gets ignored.
 */
export class Ewma {
  private readonly alpha: number;
  private readonly warmup: number;
  private _mean = 0;
  private _variance = 0;
  private _count = 0;

  constructor({ alpha = 0.1, warmupSamples = 10 }: EwmaOptions = {}) {
    if (alpha <= 0 || alpha > 1) throw new RangeError('alpha must be in (0, 1]');
    this.alpha = alpha;
    this.warmup = warmupSamples;
  }

  update(value: number): void {
    if (!Number.isFinite(value)) return;
    this._count += 1;
    if (this._count === 1) {
      this._mean = value;
      return;
    }
    const delta = value - this._mean;
    this._mean += this.alpha * delta;
    // West's incremental EWMA variance.
    this._variance = (1 - this.alpha) * (this._variance + this.alpha * delta * delta);
  }

  get mean(): number { return this._mean; }
  get variance(): number { return this._variance; }
  get stdDev(): number { return Math.sqrt(this._variance); }
  get count(): number { return this._count; }
  get ready(): boolean { return this._count >= this.warmup; }

  reset(): void {
    this._mean = 0;
    this._variance = 0;
    this._count = 0;
  }
}

/**
 * Rolling median and median absolute deviation over a bounded window.
 *
 * O(n log n) per query rather than per insert, which is the right trade at
 * these window sizes - a few hundred samples queried once per poll.
 */
export class RollingMad {
  private readonly window: number;
  private readonly samples: number[] = [];

  constructor(windowSize = 200) {
    if (windowSize < 3) throw new RangeError('windowSize must be at least 3');
    this.window = windowSize;
  }

  push(value: number): void {
    if (!Number.isFinite(value)) return;
    this.samples.push(value);
    if (this.samples.length > this.window) this.samples.shift();
  }

  get count(): number { return this.samples.length; }

  get median(): number {
    return RollingMad.medianOf(this.samples);
  }

  /** Median absolute deviation, scaled to be comparable with a std deviation. */
  get mad(): number {
    if (this.samples.length === 0) return 0;
    const med = this.median;
    const deviations = this.samples.map((s) => Math.abs(s - med));
    return RollingMad.medianOf(deviations) * MAD_TO_SIGMA;
  }

  /**
   * Robust z-score: how many scaled MADs the value sits from the median.
   *
   * When MAD is zero - a perfectly flat series, which is common for a counter
   * that has not moved - any deviation at all is infinitely many MADs. That is
   * technically true and operationally useless, so a flat series reports 0
   * unless the value differs from the median, in which case it reports a fixed
   * large score rather than Infinity.
   */
  zScore(value: number): number {
    if (this.samples.length < 3) return 0;
    const mad = this.mad;
    if (mad === 0) return value === this.median ? 0 : 6;
    return (value - this.median) / mad;
  }

  reset(): void { this.samples.length = 0; }

  static medianOf(values: readonly number[]): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
      ? ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2
      : (sorted[mid] as number);
  }
}

/**
 * Which hour-of-week bucket a timestamp belongs to.
 *
 * Network load is strongly periodic: an office router at 09:00 on a Tuesday
 * looks nothing like the same router at 03:00 on a Sunday, and a baseline that
 * averages them together is wide enough to hide everything. 168 buckets is one
 * per hour of the week, which captures both the working-day and the weekend
 * shape without needing much history per bucket.
 */
export function hourOfWeek(date: Date = new Date()): number {
  return date.getDay() * 24 + date.getHours();
}

export interface BaselineOptions extends EwmaOptions {
  /** Window for the robust median/MAD statistics. */
  madWindow?: number;
  /** Track a separate baseline per hour-of-week. */
  seasonal?: boolean;
  /** |z| above this counts as anomalous. 3.5 is the conventional MAD threshold. */
  anomalyZ?: number;
}

export interface BaselineVerdict {
  /** True only when the baseline is warmed up AND the value is an outlier. */
  anomalous: boolean;
  /** Robust z-score. Positive means above normal. */
  z: number;
  /** What normal currently looks like. */
  expected: number;
  /** Scaled MAD, i.e. the spread of normal. */
  spread: number;
  /** False while still learning; no verdict should be trusted yet. */
  ready: boolean;
  /** Samples seen for whichever baseline was consulted. */
  samples: number;
  /** 'seasonal' when an hour-of-week bucket was used, otherwise 'global'. */
  basis: 'seasonal' | 'global';
}

/**
 * A baseline for one metric on one entity.
 *
 * Keeps a global baseline always, and optionally a per-hour-of-week one that
 * is preferred once it has enough of its own history. Falling back to global
 * matters: a seasonal bucket only sees one sample per week per poll slot, so
 * without a fallback the first week produces no verdicts at all.
 */
export class Baseline {
  private readonly opts: Required<BaselineOptions>;
  private readonly global: { ewma: Ewma; mad: RollingMad };
  private readonly seasons = new Map<number, { ewma: Ewma; mad: RollingMad }>();

  constructor(options: BaselineOptions = {}) {
    this.opts = {
      alpha: options.alpha ?? 0.1,
      warmupSamples: options.warmupSamples ?? 10,
      madWindow: options.madWindow ?? 200,
      seasonal: options.seasonal ?? false,
      anomalyZ: options.anomalyZ ?? 3.5,
    };
    this.global = this.newSeries();
  }

  private newSeries() {
    return {
      ewma: new Ewma({ alpha: this.opts.alpha, warmupSamples: this.opts.warmupSamples }),
      mad: new RollingMad(this.opts.madWindow),
    };
  }

  private seasonFor(at: Date) {
    const key = hourOfWeek(at);
    let series = this.seasons.get(key);
    if (!series) {
      series = this.newSeries();
      this.seasons.set(key, series);
    }
    return series;
  }

  /** Records a sample into the global baseline and, if enabled, its season. */
  observe(value: number, at: Date = new Date()): void {
    if (!Number.isFinite(value)) return;
    this.global.ewma.update(value);
    this.global.mad.push(value);
    if (this.opts.seasonal) {
      const s = this.seasonFor(at);
      s.ewma.update(value);
      s.mad.push(value);
    }
  }

  /** Judges a value without recording it. */
  evaluate(value: number, at: Date = new Date()): BaselineVerdict {
    let series = this.global;
    let basis: 'seasonal' | 'global' = 'global';

    if (this.opts.seasonal) {
      const s = this.seasonFor(at);
      if (s.ewma.ready) { series = s; basis = 'seasonal'; }
    }

    const ready = series.ewma.ready && series.mad.count >= 3;
    const z = series.mad.zScore(value);

    return {
      anomalous: ready && Math.abs(z) >= this.opts.anomalyZ,
      z: Number.isFinite(z) ? Math.round(z * 100) / 100 : 0,
      expected: Math.round(series.mad.median * 100) / 100,
      spread: Math.round(series.mad.mad * 100) / 100,
      ready,
      samples: series.ewma.count,
      basis,
    };
  }

  /** Evaluate then observe, which is the normal order for a live sample. */
  submit(value: number, at: Date = new Date()): BaselineVerdict {
    const verdict = this.evaluate(value, at);
    this.observe(value, at);
    return verdict;
  }

  reset(): void {
    this.global.ewma.reset();
    this.global.mad.reset();
    this.seasons.clear();
  }
}

/**
 * Baselines keyed by entity and metric, so one object covers a whole agent.
 *
 * Bounded: an unbounded map keyed by anything derived from network input is a
 * memory leak, and this framework has already had one of those.
 */
export class BaselineSet {
  private readonly map = new Map<string, Baseline>();

  constructor(
    private readonly options: BaselineOptions = {},
    private readonly maxSeries = 500,
  ) {}

  private keyFor(entity: string, metric: string): string {
    return `${entity}::${metric}`;
  }

  for(entity: string, metric: string): Baseline {
    const key = this.keyFor(entity, metric);
    let b = this.map.get(key);
    if (!b) {
      if (this.map.size >= this.maxSeries) {
        const oldest = this.map.keys().next().value as string | undefined;
        if (oldest !== undefined) this.map.delete(oldest);
      }
      b = new Baseline(this.options);
      this.map.set(key, b);
    }
    return b;
  }

  submit(entity: string, metric: string, value: number, at: Date = new Date()): BaselineVerdict {
    return this.for(entity, metric).submit(value, at);
  }

  get size(): number { return this.map.size; }
  reset(): void { this.map.clear(); }
}
