const { SlidingWindowCounter, PortScanDetector, Hysteresis } = require('@ragent/analytics');

/**
 * Rate-based intrusion detection.
 *
 * The previous authentication monitor counted failures against a fixed number
 * with no window: five failed logins spread over a working day looked identical
 * to five in two seconds. Only one of those is an attack, and a counter without
 * time cannot tell them apart.
 *
 * Three detections here, all over real received syslog:
 *
 *   Credential brute force - a rate of failures from one source.
 *   Password spraying      - a moderate rate from many sources at once, which
 *                            per-source thresholds are specifically designed
 *                            to slip under and therefore always miss.
 *   Port scanning          - one source touching many distinct ports.
 *
 * Distinct ports rather than connection count is the point of the third: a
 * client opening two hundred connections to 443 is a busy user, while twenty
 * connections across twenty ports is a scan. Counting connections flags the
 * first and misses the second.
 */

class ThreatDetector {
  constructor({ findingStore = null, logger = console, config = {} } = {}) {
    this.findings = findingStore;
    this.logger = logger;

    const windowMs = (config.time_window_seconds ?? 300) * 1000;
    this.perSourceThreshold = config.max_failed_attempts ?? 5;
    // Spraying is deliberately lower per source: the technique's whole purpose
    // is staying under a per-source threshold.
    this.sprayDistinctSources = config.spray_distinct_sources ?? 5;
    this.sprayPerSourceMin = config.spray_per_source_min ?? 2;

    this.authFailures = new SlidingWindowCounter(windowMs);
    this.authByUser = new SlidingWindowCounter(windowMs);
    this.scans = new PortScanDetector({
      windowMs,
      distinctPortThreshold: config.port_scan_distinct_ports ?? 15,
    });

    this.alarms = new Map();
    /** Sources already reported as scanning, so one scan is one finding. */
    this.reportedScans = new Set();
    this.windowMs = windowMs;
    this.stats = { authFailures: 0, bruteForce: 0, spraying: 0, portScans: 0 };
  }

  alarmFor(key, raiseAt) {
    let a = this.alarms.get(key);
    if (!a) {
      a = new Hysteresis({
        raiseAt,
        clearAt: Math.max(raiseAt * 0.5, 1),
        raiseAfter: 1,
        clearAfter: 3,
      });
      this.alarms.set(key, a);
    }
    return a;
  }

  emit(spec, entity) {
    if (!this.findings) return null;
    const { finding, isNew } = this.findings.report({
      agent: 'agent3-security',
      entity,
      ...spec,
    });
    if (isNew) this.logger.warn?.(`FINDING [${spec.severity}] ${spec.title}`);
    return finding;
  }

  /**
   * Records an authentication failure and evaluates both detections.
   *
   * @param {{sourceIp: string, username?: string, router?: string, at?: number}} event
   */
  recordAuthFailure({ sourceIp, username = 'unknown', router = 'unknown', at = Date.now() }) {
    if (!sourceIp) return [];
    this.stats.authFailures++;

    const perSource = this.authFailures.record(sourceIp, at);
    this.authByUser.record(`${username}@${sourceIp}`, at);

    const emitted = [];
    const windowSec = Math.round(this.windowMs / 1000);

    // --- brute force: one source, high rate -------------------------------
    const bfAlarm = this.alarmFor(`bf::${sourceIp}`, this.perSourceThreshold);
    const bf = bfAlarm.update(perSource, at);
    const critical = perSource >= this.perSourceThreshold * 4;

    // Re-emit when the rate crosses into critical, even though the alarm is
    // already raised. Severity computed once at the raise sample would freeze
    // at "high" while an attack accelerated - the finding store escalates but
    // never de-escalates, so this is safe to send repeatedly.
    const escalating = bfAlarm.isRaised && !bf.changed && critical;

    if ((bf.changed && bf.state === 'raised') || escalating) {
      this.stats.bruteForce++;
      const f = this.emit(
        {
          kind: 'auth_failure_burst',
          severity: critical ? 'critical' : 'high',
          title: `Credential brute force from ${sourceIp}`,
          detail:
            `${perSource} authentication failures from ${sourceIp} in ${windowSec}s ` +
            `(threshold ${this.perSourceThreshold}). Most recent user: ${username}.`,
          evidence: {
            sourceIp,
            failuresInWindow: perSource,
            windowSeconds: windowSec,
            threshold: this.perSourceThreshold,
            lastUsername: username,
          },
          tags: ['authentication', sourceIp],
        },
        { type: 'router', id: router, name: router },
      );
      if (f) emitted.push(f);
    } else if (bf.changed) {
      this.findings.clear('agent3-security', 'auth_failure_burst', { type: 'router', id: router });
    }

    // --- spraying: many sources, each individually quiet -------------------
    const active = this.authFailures.keysAtOrAbove(this.sprayPerSourceMin, at);
    if (active.length >= this.sprayDistinctSources) {
      const sprayAlarm = this.alarmFor(`spray::${router}`, this.sprayDistinctSources);
      const sp = sprayAlarm.update(active.length, at);
      if (sp.changed && sp.state === 'raised') {
        this.stats.spraying++;
        const f = this.emit(
          {
            kind: 'auth_failure_distributed',
            severity: 'high',
            title: `Distributed authentication failures against ${router}`,
            detail:
              `${active.length} distinct sources each produced at least ${this.sprayPerSourceMin} ` +
              `failures within ${windowSec}s. Individually all are below the per-source threshold ` +
              `of ${this.perSourceThreshold}, which is what password spraying is designed to achieve.`,
            evidence: {
              distinctSources: active.length,
              perSourceMinimum: this.sprayPerSourceMin,
              totalFailures: active.reduce((s, k) => s + k.count, 0),
              topSources: active.slice(0, 5),
              windowSeconds: windowSec,
            },
            tags: ['authentication', 'distributed'],
          },
          { type: 'router', id: router, name: router },
        );
        if (f) emitted.push(f);
      }
    }

    return emitted;
  }

  /**
   * Records a connection attempt and evaluates for scanning.
   */
  recordConnection({ sourceIp, port, router = 'unknown', at = Date.now() }) {
    if (!sourceIp || !Number.isFinite(port)) return null;
    const verdict = this.scans.record(sourceIp, port, at);
    if (!verdict.detected) return null;

    // A simple "already reported" set rather than hysteresis: the detector's
    // own sliding window is the damping, and a boolean has no band to sit in.
    // Using Hysteresis here needed raiseAt=1, which makes clearAt equal raiseAt
    // and is correctly rejected by its constructor.
    if (this.reportedScans.has(sourceIp)) return null;
    this.reportedScans.add(sourceIp);
    if (this.reportedScans.size > 500) {
      this.reportedScans.delete(this.reportedScans.values().next().value);
    }

    this.stats.portScans++;
    return this.emit(
      {
        kind: 'port_scan',
        severity: 'high',
        title: `Port scan from ${sourceIp}`,
        detail:
          `${sourceIp} touched ${verdict.distinctPorts} distinct ports within ` +
          `${Math.round(verdict.windowMs / 1000)}s. Distinct ports rather than connection ` +
          'count is what distinguishes a scan from a busy client.',
        evidence: {
          sourceIp,
          distinctPorts: verdict.distinctPorts,
          windowSeconds: Math.round(verdict.windowMs / 1000),
        },
        tags: ['scanning', sourceIp],
      },
      { type: 'router', id: router, name: router },
    );
  }

  getStats() {
    return {
      ...this.stats,
      trackedSources: this.authFailures.keyCount,
      windowSeconds: Math.round(this.windowMs / 1000),
    };
  }
}

module.exports = ThreatDetector;
