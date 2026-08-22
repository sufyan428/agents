const {
  latencyStats, analyseLoss, forecastSaturation, Hysteresis,
} = require('@ragent/analytics');

/**
 * Real link-quality analysis, replacing means and generated numbers.
 *
 * Three things this framework reported before that were not measurements of
 * anything useful:
 *
 *   Mean latency, which hides the tail that users actually notice. Ninety-four
 *   fast probes and six timeouts still averages under 130ms and looks fine.
 *
 *   "Jitter" computed as the difference between the last two samples. That is
 *   one sample of the quantity jitter smooths, not jitter. RFC 3550 defines it,
 *   every other network tool implements that definition, and a number that does
 *   not match it cannot be compared with anything.
 *
 *   A loss percentage with no notion of distribution. 2% scattered is
 *   background noise on any real link; the same 2% arriving as one 40-packet
 *   burst is an outage people complained about. Identical average.
 *
 * Everything here works on the probe history the ICMP tracker already collects.
 */

/** Probes retained per destination for percentile and burst analysis. */
const HISTORY = 120;

class QualityAnalyzer {
  constructor({ findingStore = null, logger = console, thresholds = {} } = {}) {
    this.findings = findingStore;
    this.logger = logger;
    this.thresholds = {
      p95LatencyMs: thresholds.p95LatencyMs ?? 150,
      jitterMs: thresholds.jitterMs ?? 30,
      lossPercent: thresholds.lossPercent ?? 2,
      saturation: thresholds.saturation ?? 0.9,
    };

    /** destination -> { latencies: number[], probes: boolean[] } */
    this.history = new Map();
    /** destination -> { interface -> {at, utilisation}[] } */
    this.utilisation = new Map();
    /** key -> Hysteresis */
    this.alarms = new Map();
  }

  historyFor(dest) {
    let h = this.history.get(dest);
    if (!h) { h = { latencies: [], probes: [] }; this.history.set(dest, h); }
    return h;
  }

  alarmFor(key, raiseAt) {
    let a = this.alarms.get(key);
    if (!a) {
      a = new Hysteresis({ raiseAt, clearAt: raiseAt * 0.8, raiseAfter: 2, clearAfter: 3 });
      this.alarms.set(key, a);
    }
    return a;
  }

  /**
   * Records one probe result.
   *
   * @param {string} dest
   * @param {{latencyMs: number|null, lost: boolean}} probe
   */
  recordProbe(dest, { latencyMs, lost }) {
    const h = this.historyFor(dest);
    h.probes.push(Boolean(lost));
    if (h.probes.length > HISTORY) h.probes.shift();
    if (!lost && Number.isFinite(latencyMs)) {
      h.latencies.push(latencyMs);
      if (h.latencies.length > HISTORY) h.latencies.shift();
    }
  }

  /** Full quality picture for one destination. */
  analyse(dest) {
    const h = this.historyFor(dest);
    const latency = latencyStats(h.latencies);
    const loss = analyseLoss(h.probes);
    return {
      destination: dest,
      samples: h.probes.length,
      latency,
      loss: {
        ...loss,
        lossPercent: Math.round(loss.lossRate * 10000) / 100,
      },
      measured: true,
    };
  }

  /** Records interface utilisation for saturation forecasting. */
  recordUtilisation(entity, iface, utilisation, at = Date.now()) {
    let byIface = this.utilisation.get(entity);
    if (!byIface) { byIface = new Map(); this.utilisation.set(entity, byIface); }
    let series = byIface.get(iface);
    if (!series) { series = []; byIface.set(iface, series); }
    series.push({ at, utilisation });
    if (series.length > HISTORY) series.shift();
  }

  forecast(entity, iface) {
    const series = this.utilisation.get(entity)?.get(iface) ?? [];
    return forecastSaturation(series, this.thresholds.saturation);
  }

  /**
   * Evaluates a destination and emits findings for anything genuinely wrong.
   *
   * Each check is separately hysteresis-damped, so a link with a bad tail and
   * bursty loss produces two findings that each transition once, rather than a
   * stream that restarts on every probe.
   */
  evaluate(dest, entityName = dest) {
    if (!this.findings) return [];
    const a = this.analyse(dest);
    if (a.samples < 10) return [];

    const emitted = [];
    const entity = { type: 'router', id: entityName, name: entityName };
    const now = Date.now();

    const check = (key, value, raiseAt, build) => {
      const alarm = this.alarmFor(`${dest}::${key}`, raiseAt);
      const r = alarm.update(value, now);
      if (!r.changed) return;
      if (r.state === 'raised') {
        const spec = build();
        const { finding } = this.findings.report({
          agent: 'agent4-performance',
          entity,
          tags: [dest],
          ...spec,
        });
        emitted.push(finding);
        this.logger.warn?.(`FINDING [${spec.severity}] ${spec.title}`);
      } else {
        this.findings.clear('agent4-performance', build().kind, entity);
      }
    };

    check('p95', a.latency.p95, this.thresholds.p95LatencyMs, () => ({
      kind: 'latency_tail_high',
      severity: a.latency.p95 > this.thresholds.p95LatencyMs * 2 ? 'high' : 'medium',
      title: `Latency tail to ${dest} is high`,
      detail:
        `p95 is ${a.latency.p95}ms against a threshold of ${this.thresholds.p95LatencyMs}ms. ` +
        `The mean is ${a.latency.mean}ms, which is why a mean alone would not show this.`,
      evidence: { ...a.latency, thresholdMs: this.thresholds.p95LatencyMs, samples: a.samples },
    }));

    check('jitter', a.latency.jitter, this.thresholds.jitterMs, () => ({
      kind: 'jitter_high',
      severity: 'medium',
      title: `Jitter to ${dest} is high`,
      detail: `RFC 3550 interarrival jitter is ${a.latency.jitter}ms against a threshold of ${this.thresholds.jitterMs}ms.`,
      evidence: { jitterMs: a.latency.jitter, thresholdMs: this.thresholds.jitterMs, method: 'RFC3550', samples: a.samples },
    }));

    check('loss', a.loss.lossPercent, this.thresholds.lossPercent, () => ({
      kind: 'packet_loss_high',
      // Bursty loss is worse than the same rate scattered: it means an outage
      // somebody noticed, not background noise.
      severity: a.loss.bursty ? 'high' : 'medium',
      title: a.loss.bursty
        ? `Bursty packet loss to ${dest}`
        : `Packet loss to ${dest}`,
      detail: a.loss.bursty
        ? `${a.loss.lossPercent}% loss arriving in bursts, longest run ${a.loss.longestBurst} probes. ` +
          'Concentrated loss like this is an interruption, not background noise.'
        : `${a.loss.lossPercent}% loss, scattered across ${a.samples} probes.`,
      evidence: { ...a.loss, samples: a.samples },
    }));

    return emitted;
  }

  /** Emits a finding when a link is trending toward saturation. */
  evaluateSaturation(entity, iface) {
    if (!this.findings) return null;
    const f = this.forecast(entity, iface);
    if (!f.confident || f.secondsToSaturation === null || f.secondsToSaturation > 3600) return null;

    const minutes = Math.round(f.secondsToSaturation / 60);
    const { finding } = this.findings.report({
      agent: 'agent4-performance',
      kind: 'bandwidth_saturation_forecast',
      severity: minutes <= 15 ? 'high' : 'medium',
      entity: { type: 'interface', id: `${entity}/${iface}`, name: `${iface} on ${entity}` },
      title: `${iface} is trending toward saturation`,
      detail:
        `Utilisation is ${Math.round(f.current * 100)}% and rising; on the current trend it reaches ` +
        `${Math.round(this.thresholds.saturation * 100)}% in about ${minutes} minutes.`,
      evidence: {
        currentUtilisation: f.current,
        trendPerSecond: f.trendPerSecond,
        secondsToSaturation: f.secondsToSaturation,
        method: 'least_squares_linear',
      },
      tags: [iface],
    });
    return finding;
  }
}

module.exports = QualityAnalyzer;
