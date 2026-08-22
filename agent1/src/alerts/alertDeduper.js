/**
 * Suppression and resolution for repeated alerts.
 *
 * Without this, a CPU that sits above its threshold produces one alert - and
 * one email - on every poll cycle, which at the default 30s interval is 120 an
 * hour for a single ongoing condition. Operators respond to that by muting the
 * channel, which is worse than never having alerted at all.
 *
 * Three behaviours, all of which real monitoring systems have and this one
 * did not:
 *
 *   Cooldown    the same condition does not re-notify until the window expires
 *   Escalation  a condition that worsens breaks through the cooldown, because
 *               warning -> critical is new information
 *   Resolution  a condition that clears sends exactly one "resolved" notice, so
 *               an operator learns the incident ended without having to poll
 */

const SEVERITY_RANK = { info: 0, warning: 1, critical: 2 };

class AlertDeduper {
  /**
   * @param {object} opts
   * @param {number} opts.cooldownMs      silence for a steady condition
   * @param {number} opts.resolveAfterMs  quiet time before a condition counts as cleared
   */
  constructor({ cooldownMs = 15 * 60 * 1000, resolveAfterMs = 5 * 60 * 1000 } = {}) {
    this.cooldownMs = cooldownMs;
    this.resolveAfterMs = resolveAfterMs;
    /** @type {Map<string, {severity: string, firstSeen: number, lastSeen: number, lastNotified: number, count: number, alert: object}>} */
    this.active = new Map();
  }

  /** Identity of a condition: same metric, same router. Severity excluded so an escalation updates one entry rather than creating a second. */
  static keyFor(alert) {
    return `${alert.router}::${alert.metric}`;
  }

  /**
   * Decides whether an alert should be delivered.
   *
   * @returns {{deliver: boolean, reason: string, occurrence: number}}
   */
  consider(alert, now = Date.now()) {
    const key = AlertDeduper.keyFor(alert);
    const existing = this.active.get(key);

    if (!existing) {
      this.active.set(key, {
        severity: alert.severity,
        firstSeen: now,
        lastSeen: now,
        lastNotified: now,
        count: 1,
        alert,
      });
      return { deliver: true, reason: 'new', occurrence: 1 };
    }

    existing.lastSeen = now;
    existing.count += 1;
    existing.alert = alert;

    const worse = (SEVERITY_RANK[alert.severity] ?? 0) > (SEVERITY_RANK[existing.severity] ?? 0);
    if (worse) {
      existing.severity = alert.severity;
      existing.lastNotified = now;
      return { deliver: true, reason: 'escalated', occurrence: existing.count };
    }

    if (now - existing.lastNotified >= this.cooldownMs) {
      existing.lastNotified = now;
      return { deliver: true, reason: 'cooldown_expired', occurrence: existing.count };
    }

    return { deliver: false, reason: 'suppressed', occurrence: existing.count };
  }

  /**
   * Conditions that have stopped recurring, with their entries removed.
   *
   * Callers send one resolution notice per returned item. A condition is only
   * considered cleared after `resolveAfterMs` of silence, so a single missed
   * poll does not produce a spurious resolve/re-alert pair.
   */
  collectResolved(now = Date.now()) {
    const resolved = [];
    for (const [key, entry] of this.active.entries()) {
      if (now - entry.lastSeen >= this.resolveAfterMs) {
        resolved.push({
          key,
          router: entry.alert.router,
          metric: entry.alert.metric,
          severity: entry.severity,
          firstSeen: new Date(entry.firstSeen).toISOString(),
          lastSeen: new Date(entry.lastSeen).toISOString(),
          durationMs: entry.lastSeen - entry.firstSeen,
          occurrences: entry.count,
        });
        this.active.delete(key);
      }
    }
    return resolved;
  }

  /** Snapshot for /status, so an operator can see what is being suppressed. */
  activeConditions() {
    return Array.from(this.active.entries()).map(([key, e]) => ({
      key,
      router: e.alert.router,
      metric: e.alert.metric,
      severity: e.severity,
      occurrences: e.count,
      firstSeen: new Date(e.firstSeen).toISOString(),
      lastSeen: new Date(e.lastSeen).toISOString(),
      suppressedSinceLastNotify: e.count > 1,
    }));
  }

  reset() {
    this.active.clear();
  }
}

module.exports = AlertDeduper;
