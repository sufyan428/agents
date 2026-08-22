const { BaselineSet, Hysteresis } = require('@ragent/analytics');
const logger = require('../utils/logger');

/**
 * Threshold evaluation with a learned baseline and hysteresis.
 *
 * The previous processor compared each sample against a fixed number. That is
 * wrong in both directions on the same fleet: a router that idles at 20% is in
 * trouble at 60 and says nothing, while one that normally sits at 78 pages
 * somebody every afternoon for behaving exactly as it always has.
 *
 * This keeps the configured thresholds - they are a real operator intent, and a
 * device at 98% CPU is in trouble whatever its history says - but adds two
 * things around them:
 *
 *   A learned baseline per router per metric, so a departure from normal is
 *   caught even when it never crosses the fixed line.
 *
 *   Hysteresis on both, so a value resting on a threshold cannot produce a
 *   state change on every poll.
 *
 * A finding is emitted on transitions only, not on every sample, and cleared
 * when the condition ends.
 */

/** Fixed thresholds still get a clear band beneath them. */
const CLEAR_MARGIN = 0.9;

class BaselineProcessor {
  /**
   * @param {object} opts
   * @param {import('@ragent/agent-common').FindingStore} opts.findingStore
   * @param {object} opts.thresholds  metric -> { warning, critical }
   */
  constructor({ findingStore, thresholds = {}, baselineOptions = {} } = {}) {
    this.findings = findingStore;
    this.thresholds = thresholds;

    this.baselines = new BaselineSet({
      alpha: 0.1,
      warmupSamples: 12,   // 6 minutes at a 30s poll: long enough to be safe, short enough to be useful
      madWindow: 200,
      seasonal: true,
      anomalyZ: 3.5,
      ...baselineOptions,
    });

    /** `${entity}::${metric}::${band}` -> Hysteresis */
    this.alarms = new Map();
  }

  alarmFor(entity, metric, band, raiseAt, inverted = false) {
    const key = `${entity}::${metric}::${band}`;
    let alarm = this.alarms.get(key);
    if (!alarm) {
      alarm = new Hysteresis({
        raiseAt,
        clearAt: inverted ? raiseAt / CLEAR_MARGIN : raiseAt * CLEAR_MARGIN,
        raiseAfter: 2,
        clearAfter: 3,
        inverted,
      });
      this.alarms.set(key, alarm);
    }
    return alarm;
  }

  /**
   * Evaluates one metric sample.
   *
   * @returns {{finding: object|null, cleared: boolean, verdict: object}}
   */
  process(entity, metric, value, { unit = '', at = new Date() } = {}) {
    if (!Number.isFinite(value)) {
      return { finding: null, cleared: false, verdict: null };
    }

    const verdict = this.baselines.submit(entity, metric, value, at);
    const threshold = this.thresholds[metric];

    // --- fixed thresholds, which express operator intent ------------------
    for (const band of ['critical', 'warning']) {
      const limit = threshold?.[band];
      if (typeof limit !== 'number') continue;

      const alarm = this.alarmFor(entity, metric, band, limit);
      const result = alarm.update(value, at.getTime());
      if (!result.changed) continue;

      if (result.state === 'raised') {
        return {
          cleared: false,
          verdict,
          finding: this.emit({
            entity, metric, at,
            kind: `${metric}_threshold_exceeded`,
            severity: band === 'critical' ? 'critical' : 'high',
            title: `${metric} above the ${band} threshold on ${entity}`,
            detail: `${value}${unit} exceeded the configured ${band} threshold of ${limit}${unit}.`,
            evidence: {
              value, threshold: limit, band, unit,
              baselineExpected: verdict.expected,
              baselineZ: verdict.z,
              basis: 'configured_threshold',
            },
          }),
        };
      }
      this.clear(entity, `${metric}_threshold_exceeded`);
      return { finding: null, cleared: true, verdict };
    }

    // --- learned baseline, which catches what a fixed line cannot ---------
    // Only consulted when no fixed threshold fired, so one condition does not
    // produce two findings.
    if (verdict.ready && verdict.anomalous) {
      const alarm = this.alarmFor(entity, `${metric}_baseline`, 'anomaly', 3.5);
      const result = alarm.update(Math.abs(verdict.z), at.getTime());
      if (result.changed && result.state === 'raised') {
        const direction = verdict.z > 0 ? 'above' : 'below';
        return {
          cleared: false,
          verdict,
          finding: this.emit({
            entity, metric, at,
            kind: `${metric}_baseline_anomaly`,
            severity: Math.abs(verdict.z) >= 6 ? 'high' : 'medium',
            title: `${metric} is unusually ${direction} normal on ${entity}`,
            detail:
              `${value}${unit} is ${Math.abs(verdict.z)} MADs ${direction} the learned baseline of ` +
              `${verdict.expected}${unit}. No configured threshold was crossed.`,
            evidence: {
              value, unit,
              baselineExpected: verdict.expected,
              baselineSpread: verdict.spread,
              z: verdict.z,
              basis: verdict.basis === 'seasonal' ? 'hour_of_week_baseline' : 'global_baseline',
              samples: verdict.samples,
            },
          }),
        };
      }
    } else if (verdict.ready) {
      const alarm = this.alarmFor(entity, `${metric}_baseline`, 'anomaly', 3.5);
      const result = alarm.update(Math.abs(verdict.z), at.getTime());
      if (result.changed && result.state === 'clear') {
        this.clear(entity, `${metric}_baseline_anomaly`);
        return { finding: null, cleared: true, verdict };
      }
    }

    return { finding: null, cleared: false, verdict };
  }

  emit({ entity, metric, kind, severity, title, detail, evidence, at }) {
    const { finding, isNew } = this.findings.report({
      agent: 'agent1-monitoring',
      kind,
      severity,
      entity: { type: 'router', id: entity, name: entity },
      title,
      detail,
      evidence,
      tags: [metric],
    }, at);
    if (isNew) logger.warn(`FINDING [${severity}] ${title}`);
    return finding;
  }

  clear(entity, kind) {
    this.findings.clear('agent1-monitoring', kind, { type: 'router', id: entity });
  }

  /** Baseline state for /status, so an operator can see what it has learned. */
  describe() {
    return { trackedSeries: this.baselines.size, activeAlarms: this.alarms.size };
  }
}

module.exports = BaselineProcessor;
