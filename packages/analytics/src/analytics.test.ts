import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Ewma,
  RollingMad,
  Baseline,
  BaselineSet,
  hourOfWeek,
  Hysteresis,
  FlapDetector,
  percentile,
  rfc3550Jitter,
  latencyStats,
  analyseLoss,
  forecastSaturation,
  SlidingWindowCounter,
  PortScanDetector,
  correlate,
  suppressibleFindingIds,
  type CorrelatableFinding,
} from './index';

/* -------------------------------- baseline ------------------------------- */

test('EWMA tracks a shifted mean and reports warmup honestly', () => {
  const e = new Ewma({ alpha: 0.3, warmupSamples: 5 });
  for (let i = 0; i < 4; i++) e.update(10);
  assert.equal(e.ready, false, 'must not claim readiness before warmup');
  e.update(10);
  assert.equal(e.ready, true);
  assert.ok(Math.abs(e.mean - 10) < 0.01);
  for (let i = 0; i < 50; i++) e.update(20);
  assert.ok(Math.abs(e.mean - 20) < 0.5, `converged to ${e.mean}`);
});

test('MAD is not skewed by a single extreme outlier, unlike stddev', () => {
  // The reason MAD is used: one spike must not raise the bar enough to hide
  // the next one.
  const m = new RollingMad(50);
  for (let i = 0; i < 30; i++) m.push(20 + (i % 3));
  const before = m.mad;
  m.push(100000);
  assert.ok(m.mad < before * 2, `MAD barely moved: ${before} -> ${m.mad}`);
  assert.ok(Math.abs(m.median - 21) <= 1, `median stable at ${m.median}`);
});

test('a flat series does not report infinite z-scores', () => {
  const m = new RollingMad();
  for (let i = 0; i < 20; i++) m.push(50);
  assert.equal(m.zScore(50), 0);
  assert.ok(Number.isFinite(m.zScore(80)), 'must be finite, not Infinity');
});

test('a baseline learns normal and flags a genuine departure', () => {
  const b = new Baseline({ warmupSamples: 10, anomalyZ: 3.5 });
  for (let i = 0; i < 40; i++) b.observe(20 + (i % 5));
  const normal = b.evaluate(22);
  assert.equal(normal.anomalous, false);
  assert.equal(normal.ready, true);
  const spike = b.evaluate(95);
  assert.equal(spike.anomalous, true);
  assert.ok(spike.z > 3.5, `z=${spike.z}`);
});

test('nothing is anomalous before warmup, however extreme', () => {
  // A monitor that alarms for five minutes after every restart gets muted.
  const b = new Baseline({ warmupSamples: 20 });
  b.observe(20);
  b.observe(21);
  const v = b.evaluate(9999);
  assert.equal(v.anomalous, false);
  assert.equal(v.ready, false);
});

test('a high-but-normal baseline does not alarm where a fixed threshold would', () => {
  // The case a fixed "alert above 80" gets wrong: this device idles at 78.
  const b = new Baseline({ warmupSamples: 10 });
  for (let i = 0; i < 40; i++) b.observe(78 + (i % 3));
  assert.equal(b.evaluate(79).anomalous, false, 'normal for this device');
});

test('a low-but-abnormal value alarms where a fixed threshold would not', () => {
  // The mirror case: this device idles at 20, so 60 is trouble - but a fixed
  // "alert above 80" says nothing at all.
  const b = new Baseline({ warmupSamples: 10 });
  for (let i = 0; i < 40; i++) b.observe(20 + (i % 3));
  assert.equal(b.evaluate(60).anomalous, true);
});

test('seasonal baselines fall back to global until a bucket has history', () => {
  const b = new Baseline({ seasonal: true, warmupSamples: 5 });
  const monday9 = new Date('2026-01-05T09:30:00');
  for (let i = 0; i < 20; i++) b.observe(50, monday9);
  assert.equal(b.evaluate(50, monday9).basis, 'seasonal');
  const sunday3 = new Date('2026-01-04T03:30:00');
  assert.equal(b.evaluate(50, sunday3).basis, 'global', 'unseen bucket falls back');
});

test('hourOfWeek separates the week into 168 buckets', () => {
  assert.equal(hourOfWeek(new Date('2026-01-04T00:00:00')), 0);
  assert.equal(hourOfWeek(new Date('2026-01-05T09:00:00')), 33);
  assert.ok(hourOfWeek(new Date('2026-01-10T23:00:00')) < 168);
});

test('BaselineSet is bounded and does not grow without limit', () => {
  const set = new BaselineSet({ warmupSamples: 2 }, 10);
  for (let i = 0; i < 50; i++) set.submit(`router-${i}`, 'cpu', 20);
  assert.ok(set.size <= 10, `bounded at ${set.size}`);
});

/* ------------------------------- hysteresis ------------------------------ */

test('a value oscillating across the threshold produces no alarm at all', () => {
  // The regression: a single threshold with a value sitting on it changed
  // state on every other sample - 120 flips an hour from one condition.
  //
  // Requiring CONSECUTIVE breaches means an oscillating value never raises,
  // which is the correct division of labour: hysteresis damps sustained
  // conditions, and oscillation is the FlapDetector's job, not this one's.
  const h = new Hysteresis({ raiseAt: 80, clearAt: 70, raiseAfter: 2, clearAfter: 3 });
  let changes = 0;
  for (const v of [81, 79, 82, 78, 81, 79, 80.5, 79.5]) {
    if (h.update(v).changed) changes++;
  }
  assert.equal(changes, 0, `oscillation must not alarm, got ${changes} transitions`);
  assert.equal(h.state, 'clear');
});

test('a sustained breach raises once and survives dips into the band', () => {
  const h = new Hysteresis({ raiseAt: 80, clearAt: 70, raiseAfter: 2, clearAfter: 3 });
  let changes = 0;
  // Sustained above, then wobbling inside the 70-80 band, which must not clear.
  for (const v of [85, 86, 84, 75, 78, 72, 76, 88]) {
    if (h.update(v).changed) changes++;
  }
  assert.equal(h.state, 'raised');
  assert.equal(changes, 1, `exactly one transition, got ${changes}`);
});

test('raising requires consecutive breaches, so one bad sample does nothing', () => {
  const h = new Hysteresis({ raiseAt: 80, clearAt: 70, raiseAfter: 3 });
  assert.equal(h.update(95).changed, false);
  assert.equal(h.update(20).changed, false, 'a good sample resets progress');
  assert.equal(h.update(95).changed, false);
  assert.equal(h.update(95).changed, false);
  assert.equal(h.update(95).changed, true);
});

test('clearing needs a drop below clearAt, not merely below raiseAt', () => {
  const h = new Hysteresis({ raiseAt: 80, clearAt: 70, raiseAfter: 1, clearAfter: 1 });
  h.update(85);
  assert.equal(h.state, 'raised');
  h.update(75);
  assert.equal(h.state, 'raised', '75 is in the hysteresis band');
  h.update(65);
  assert.equal(h.state, 'clear');
});

test('an inverted alarm handles metrics where low is bad', () => {
  const h = new Hysteresis({
    raiseAt: 10,
    clearAt: 25,
    raiseAfter: 1,
    clearAfter: 1,
    inverted: true,
  });
  h.update(5);
  assert.equal(h.state, 'raised');
  h.update(15);
  assert.equal(h.state, 'raised', 'still inside the band');
  h.update(30);
  assert.equal(h.state, 'clear');
});

test('a misconfigured band is rejected rather than never clearing', () => {
  assert.throws(() => new Hysteresis({ raiseAt: 70, clearAt: 80 }), RangeError);
  assert.throws(() => new Hysteresis({ raiseAt: 70, clearAt: 70 }), RangeError);
});

test('flap detection fires after repeated transitions', () => {
  const f = new FlapDetector({ threshold: 4, windowMs: 60_000 });
  let now = 0;
  assert.equal(f.recordTransition((now += 1000)), false);
  assert.equal(f.recordTransition((now += 1000)), false);
  assert.equal(f.recordTransition((now += 1000)), false);
  assert.equal(f.recordTransition((now += 1000)), true, 'fourth transition is a flap');
});

test('transitions spread beyond the window are not a flap', () => {
  const f = new FlapDetector({ threshold: 4, windowMs: 60_000, cooldownMs: 1000 });
  let now = 0;
  for (let i = 0; i < 6; i++) f.recordTransition((now += 120_000));
  assert.equal(f.isFlapping(now), false, 'one transition every two minutes is not flapping');
});

/* -------------------------------- network -------------------------------- */

test('percentiles catch a tail the mean hides', () => {
  // 94 fast samples and 6 timeouts. Note 5 would put the tail exactly on the
  // p95 boundary, where nearest-rank correctly returns the last fast sample -
  // a real property of the definition, not an error.
  const values = [...Array(94).fill(10), ...Array(6).fill(2000)];
  const s = latencyStats(values);
  assert.ok(s.mean < 130, `mean ${s.mean} still looks healthy`);
  assert.equal(s.p50, 10, 'the median agrees with the mean');
  assert.equal(s.p95, 2000, 'p95 exposes the tail');
  assert.equal(s.p99, 2000);
  assert.equal(s.max, 2000);
});

test('percentile handles the edges', () => {
  assert.equal(percentile([], 95), 0);
  assert.equal(percentile([5], 95), 5);
  assert.equal(percentile([1, 2, 3, 4], 100), 4);
  assert.equal(percentile([1, 2, 3, 4], 0), 1);
});

test('RFC 3550 jitter smooths rather than reporting the last difference', () => {
  assert.equal(rfc3550Jitter([10]), 0);
  const steady = rfc3550Jitter([10, 10, 10, 10, 10]);
  assert.equal(steady, 0, 'a constant series has no jitter');
  const varied = rfc3550Jitter([10, 40, 10, 40, 10, 40]);
  assert.ok(varied > 0 && varied < 30, `smoothed to ${varied}, not the raw 30ms delta`);
});

test('bursty loss is distinguished from scattered loss at the same rate', () => {
  // Both are 20% loss. Only one of them is an outage.
  // Both are exactly 4 losses in 20 probes.
  const scattered = analyseLoss([
    false,
    true,
    false,
    false,
    true,
    false,
    false,
    true,
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    true,
    false,
    false,
    false,
  ]);
  const bursty = analyseLoss([...Array(16).fill(false), true, true, true, true]);
  assert.ok(Math.abs(scattered.lossRate - bursty.lossRate) < 0.01, 'same rate');
  assert.equal(scattered.bursty, false);
  assert.equal(bursty.bursty, true);
  assert.equal(bursty.longestBurst, 4);
});

test('loss analysis handles no probes and no loss', () => {
  assert.equal(analyseLoss([]).lossRate, 0);
  const clean = analyseLoss([false, false, false]);
  assert.equal(clean.lossRate, 0);
  assert.equal(clean.bursty, false);
});

test('saturation forecasting projects a rising trend', () => {
  const samples = Array.from({ length: 12 }, (_, i) => ({
    at: i * 60_000,
    utilisation: 0.5 + i * 0.02,
  }));
  const f = forecastSaturation(samples, 0.9);
  assert.ok(
    f.secondsToSaturation !== null && f.secondsToSaturation > 0,
    `${f.secondsToSaturation}s`,
  );
  assert.equal(f.confident, true);
});

test('a flat or falling trend forecasts no saturation', () => {
  const flat = forecastSaturation(
    Array.from({ length: 12 }, (_, i) => ({ at: i * 60_000, utilisation: 0.5 })),
    0.9,
  );
  assert.equal(flat.secondsToSaturation, null);
  const falling = forecastSaturation(
    Array.from({ length: 12 }, (_, i) => ({ at: i * 60_000, utilisation: 0.8 - i * 0.01 })),
    0.9,
  );
  assert.equal(falling.secondsToSaturation, null);
});

test('too few samples means no confident forecast', () => {
  const f = forecastSaturation(
    [
      { at: 0, utilisation: 0.5 },
      { at: 1000, utilisation: 0.6 },
    ],
    0.9,
  );
  assert.equal(f.confident, false);
  assert.equal(f.secondsToSaturation, null);
});

test('sliding window counts within the window and forgets outside it', () => {
  const c = new SlidingWindowCounter(60_000);
  const now = 1_000_000;
  for (let i = 0; i < 5; i++) c.record('10.0.0.1', now + i * 1000);
  assert.equal(c.countFor('10.0.0.1', now + 5000), 5);
  assert.equal(c.countFor('10.0.0.1', now + 120_000), 0, 'window expired');
});

test('sliding window ranks the busiest keys', () => {
  const c = new SlidingWindowCounter(60_000);
  const now = 1_000_000;
  for (let i = 0; i < 10; i++) c.record('noisy', now);
  for (let i = 0; i < 2; i++) c.record('quiet', now);
  const hot = c.keysAtOrAbove(5, now);
  assert.equal(hot.length, 1);
  assert.equal(hot[0]?.key, 'noisy');
});

test('port scan detection counts distinct ports, not connections', () => {
  const d = new PortScanDetector({ distinctPortThreshold: 10, windowMs: 60_000 });
  const now = 1_000_000;
  // A busy client hammering one port is normal traffic.
  let verdict = d.record('10.0.0.5', 443, now);
  for (let i = 0; i < 200; i++) verdict = d.record('10.0.0.5', 443, now);
  assert.equal(verdict.detected, false, '200 connections to one port is not a scan');
  // A handful of connections across many ports is.
  for (let p = 1; p <= 12; p++) verdict = d.record('10.0.0.9', p, now);
  assert.equal(verdict.detected, true);
  assert.ok(verdict.distinctPorts >= 10);
});

/* ------------------------------- correlation ----------------------------- */

const at = (min: number) => new Date(Date.UTC(2026, 0, 1, 12, min)).toISOString();
const f = (
  id: string,
  agent: string,
  kind: string,
  severity: CorrelatableFinding['severity'],
  minute: number,
  entityId = '10.0.0.1',
  simulated = false,
): CorrelatableFinding => ({
  id,
  agent,
  kind,
  severity,
  entity: { type: 'router', id: entityId, name: entityId },
  title: `${kind} on ${entityId}`,
  firstSeen: at(minute),
  lastSeen: at(minute),
  simulated,
});

test('six findings from one outage become one incident with the right cause', () => {
  // The scenario this exists for: a router loses power and six agents each
  // report their own symptom.
  const clusters = correlate([
    f('1', 'agent5-automation', 'policy_check_failed', 'medium', 2),
    f('2', 'agent4-performance', 'packet_loss_high', 'high', 1),
    f('3', 'agent2-resilience', 'device_unreachable', 'critical', 0),
    f('4', 'agent1-monitoring', 'snmp_timeout', 'high', 0),
    f('5', 'agent2-resilience', 'heartbeat_missed', 'high', 1),
    f('6', 'agent4-performance', 'latency_high', 'medium', 1),
  ]);

  assert.equal(clusters.length, 1, 'one incident, not six');
  const c = clusters[0]!;
  assert.equal(c.rootCause.kind, 'device_unreachable', `chose ${c.rootCause.kind}`);
  assert.equal(c.symptoms.length, 5);
  assert.equal(c.severity, 'critical');
  assert.ok(c.confidence > 0.6, `confidence ${c.confidence}`);
  assert.equal(c.agentsInvolved.length, 4);
  assert.match(c.reasoning, /probable cause/);
});

test('an interface problem outranks the performance symptoms it causes', () => {
  const clusters = correlate([
    f('1', 'agent4-performance', 'bandwidth_saturated', 'high', 1),
    f('2', 'agent1-monitoring', 'interface_down', 'high', 0),
    f('3', 'agent4-performance', 'qos_violation', 'medium', 1),
  ]);
  assert.equal(clusters[0]?.rootCause.kind, 'interface_down');
});

test('findings on different entities stay separate by default', () => {
  const clusters = correlate([
    f('1', 'agent1-monitoring', 'cpu_high', 'high', 0, '10.0.0.1'),
    f('2', 'agent1-monitoring', 'cpu_high', 'high', 0, '10.0.0.2'),
  ]);
  assert.equal(clusters.length, 2);
});

test('cross-entity grouping is opt-in and reports lower confidence', () => {
  const findings = [
    f('1', 'agent1-monitoring', 'device_unreachable', 'critical', 0, '10.0.0.1'),
    f('2', 'agent1-monitoring', 'device_unreachable', 'critical', 0, '10.0.0.2'),
  ];
  const merged = correlate(findings, { crossEntity: true });
  assert.equal(merged.length, 1);
  assert.ok(merged[0]!.confidence <= 0.6, 'no topology map, so confidence is capped');
  assert.match(merged[0]!.reasoning, /inference rather than evidence/);
});

test('findings far apart in time are separate incidents', () => {
  const clusters = correlate(
    [
      f('1', 'agent1-monitoring', 'cpu_high', 'high', 0),
      f('2', 'agent1-monitoring', 'cpu_high', 'high', 60),
    ],
    { windowMs: 300_000 },
  );
  assert.equal(clusters.length, 2);
});

test('a lone finding is a cluster of one with modest confidence', () => {
  const clusters = correlate([f('1', 'agent1-monitoring', 'cpu_high', 'high', 0)]);
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0]?.symptoms.length, 0);
  assert.equal(clusters[0]?.confidence, 0.5);
  assert.match(clusters[0]!.reasoning, /nothing else correlates/);
});

test('the simulated flag propagates to the whole cluster', () => {
  const clusters = correlate([
    f('1', 'agent2-resilience', 'device_unreachable', 'critical', 0),
    f('2', 'agent4-performance', 'qos_violation', 'medium', 1, '10.0.0.1', true),
  ]);
  assert.equal(clusters[0]?.simulated, true, 'one simulated input taints the incident');
});

test('symptoms are suppressible only when the grouping is confident', () => {
  const confident = correlate([
    f('1', 'agent2-resilience', 'device_unreachable', 'critical', 0),
    f('2', 'agent1-monitoring', 'snmp_timeout', 'high', 0),
    f('3', 'agent4-performance', 'latency_high', 'medium', 1),
  ]);
  const ids = suppressibleFindingIds(confident, 0.6);
  assert.ok(ids.size >= 1);
  assert.equal(ids.has('1'), false, 'the root cause is never suppressed');

  const weak = correlate([f('1', 'agent1-monitoring', 'cpu_high', 'high', 0)]);
  assert.equal(suppressibleFindingIds(weak, 0.6).size, 0, 'a weak grouping suppresses nothing');
});

test('correlate handles an empty input', () => {
  assert.deepEqual(correlate([]), []);
});
