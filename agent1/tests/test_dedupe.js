const { test } = require('node:test');
const assert = require('node:assert');
const AlertDeduper = require('../src/alerts/alertDeduper');

const alert = (over = {}) => ({
  router: 'R1',
  metric: 'cpu',
  severity: 'warning',
  value: 85,
  threshold: 80,
  message: 'CPU warning',
  ...over,
});

test('the first occurrence of a condition is delivered', () => {
  const d = new AlertDeduper();
  const r = d.consider(alert(), 0);
  assert.strictEqual(r.deliver, true);
  assert.strictEqual(r.reason, 'new');
});

test('a repeat inside the cooldown is suppressed', () => {
  const d = new AlertDeduper({ cooldownMs: 60_000 });
  d.consider(alert(), 0);
  const r = d.consider(alert(), 30_000);
  assert.strictEqual(r.deliver, false);
  assert.strictEqual(r.reason, 'suppressed');
  assert.strictEqual(r.occurrence, 2);
});

test('a steady condition re-notifies once the cooldown expires', () => {
  const d = new AlertDeduper({ cooldownMs: 60_000 });
  d.consider(alert(), 0);
  assert.strictEqual(d.consider(alert(), 59_000).deliver, false);
  const r = d.consider(alert(), 60_000);
  assert.strictEqual(r.deliver, true);
  assert.strictEqual(r.reason, 'cooldown_expired');
});

test('an escalation breaks through the cooldown', () => {
  // warning -> critical is new information and must not be swallowed.
  const d = new AlertDeduper({ cooldownMs: 60 * 60 * 1000 });
  d.consider(alert({ severity: 'warning' }), 0);
  const r = d.consider(alert({ severity: 'critical' }), 1000);
  assert.strictEqual(r.deliver, true);
  assert.strictEqual(r.reason, 'escalated');
});

test('a de-escalation does not re-notify', () => {
  const d = new AlertDeduper({ cooldownMs: 60 * 60 * 1000 });
  d.consider(alert({ severity: 'critical' }), 0);
  const r = d.consider(alert({ severity: 'warning' }), 1000);
  assert.strictEqual(r.deliver, false);
});

test('different metrics and different routers are tracked separately', () => {
  const d = new AlertDeduper({ cooldownMs: 60 * 60 * 1000 });
  assert.strictEqual(d.consider(alert({ metric: 'cpu' }), 0).deliver, true);
  assert.strictEqual(d.consider(alert({ metric: 'memory' }), 0).deliver, true);
  assert.strictEqual(d.consider(alert({ router: 'R2' }), 0).deliver, true);
  assert.strictEqual(d.consider(alert({ metric: 'cpu' }), 1).deliver, false);
});

test('a condition resolves only after the quiet window', () => {
  const d = new AlertDeduper({ resolveAfterMs: 300_000 });
  d.consider(alert(), 0);
  assert.strictEqual(d.collectResolved(299_000).length, 0, 'must not resolve early');
  const resolved = d.collectResolved(300_000);
  assert.strictEqual(resolved.length, 1);
  assert.strictEqual(resolved[0].metric, 'cpu');
  assert.strictEqual(resolved[0].occurrences, 1);
});

test('a single missed poll does not resolve a still-active condition', () => {
  const d = new AlertDeduper({ cooldownMs: 60_000, resolveAfterMs: 300_000 });
  d.consider(alert(), 0);
  d.consider(alert(), 200_000);
  assert.strictEqual(d.collectResolved(300_000).length, 0, 'lastSeen must reset the window');
  assert.strictEqual(d.collectResolved(500_001).length, 1);
});

test('a resolved condition alerts again if it returns', () => {
  const d = new AlertDeduper({ resolveAfterMs: 1000 });
  d.consider(alert(), 0);
  d.collectResolved(2000);
  const r = d.consider(alert(), 3000);
  assert.strictEqual(r.deliver, true);
  assert.strictEqual(r.reason, 'new');
});

test('resolution reports the duration and occurrence count', () => {
  const d = new AlertDeduper({ cooldownMs: 1, resolveAfterMs: 1000 });
  d.consider(alert(), 0);
  d.consider(alert(), 5000);
  d.consider(alert(), 10_000);
  const [r] = d.collectResolved(11_001);
  assert.strictEqual(r.occurrences, 3);
  assert.strictEqual(r.durationMs, 10_000);
});

test('activeConditions exposes what is currently suppressed', () => {
  const d = new AlertDeduper({ cooldownMs: 60_000 });
  d.consider(alert(), 0);
  d.consider(alert(), 1000);
  const [c] = d.activeConditions();
  assert.strictEqual(c.occurrences, 2);
  assert.strictEqual(c.suppressedSinceLastNotify, true);
});

test('an hour of a steady condition produces one notification, not 120', () => {
  // The regression this whole module exists for: at a 30s poll interval a
  // sustained threshold breach used to send an email every cycle.
  const d = new AlertDeduper({ cooldownMs: 15 * 60 * 1000 });
  let delivered = 0;
  for (let t = 0; t <= 60 * 60 * 1000; t += 30_000) {
    if (d.consider(alert(), t).deliver) delivered++;
  }
  assert.strictEqual(delivered, 5, 'one initial plus one per 15m cooldown');
});
