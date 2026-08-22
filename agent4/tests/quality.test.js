const { test } = require('node:test');
const assert = require('node:assert');
const { FindingStore } = require('@ragent/agent-common');
const QualityAnalyzer = require('../modules/quality-analyzer');

const silent = { warn() {}, info() {}, debug() {} };
const make = (thresholds = {}) => {
  const findings = new FindingStore();
  return { findings, qa: new QualityAnalyzer({ findingStore: findings, logger: silent, thresholds }) };
};

/** n good probes at `ms`, then `slow` probes at `slowMs`. */
function feed(qa, dest, { good = 0, ms = 10, slow = 0, slowMs = 500, lost = 0 } = {}) {
  for (let i = 0; i < good; i++) qa.recordProbe(dest, { latencyMs: ms, lost: false });
  for (let i = 0; i < slow; i++) qa.recordProbe(dest, { latencyMs: slowMs, lost: false });
  for (let i = 0; i < lost; i++) qa.recordProbe(dest, { latencyMs: null, lost: true });
}

test('a latency tail is caught where the mean looks healthy', () => {
  const { qa } = make({ p95LatencyMs: 150 });
  feed(qa, '10.0.0.1', { good: 94, ms: 10, slow: 6, slowMs: 2000 });
  const a = qa.analyse('10.0.0.1');
  assert.ok(a.latency.mean < 150, `mean ${a.latency.mean}ms passes a mean-based check`);
  assert.equal(a.latency.p95, 2000, 'p95 exposes it');
});

test('jitter uses the RFC 3550 definition, not the last difference', () => {
  const { qa } = make();
  for (const ms of [10, 40, 10, 40, 10, 40, 10, 40, 10, 40]) {
    qa.recordProbe('d', { latencyMs: ms, lost: false });
  }
  const j = qa.analyse('d').latency.jitter;
  assert.ok(j > 0 && j < 30, `smoothed to ${j}ms rather than reporting the raw 30ms delta`);
});

test('bursty and scattered loss at the same rate are graded differently', () => {
  const scattered = make({ lossPercent: 1 });
  for (let i = 0; i < 100; i++) scattered.qa.recordProbe('s', { latencyMs: 10, lost: i % 25 === 0 });
  // Two evaluations: raiseAfter is 2, so one reading never raises an alarm.
  scattered.qa.evaluate('s', 'R1');
  scattered.qa.evaluate('s', 'R1');

  const bursty = make({ lossPercent: 1 });
  for (let i = 0; i < 96; i++) bursty.qa.recordProbe('b', { latencyMs: 10, lost: false });
  for (let i = 0; i < 4; i++) bursty.qa.recordProbe('b', { latencyMs: null, lost: true });
  bursty.qa.evaluate('b', 'R1');
  bursty.qa.evaluate('b', 'R1');

  const sf = scattered.findings.list().find((f) => f.kind === 'packet_loss_high');
  const bf = bursty.findings.list().find((f) => f.kind === 'packet_loss_high');
  assert.ok(sf && bf, 'both should be reported');
  assert.equal(sf.severity, 'medium', 'scattered loss is the milder case');
  assert.equal(bf.severity, 'high', 'the same rate in one burst is worse');
  assert.match(bf.detail, /bursts/);
});

test('nothing is reported from too few probes', () => {
  const { qa, findings } = make({ p95LatencyMs: 1 });
  feed(qa, 'd', { good: 5, ms: 9999 });
  qa.evaluate('d', 'R1');
  assert.equal(findings.activeCount, 0);
});

test('a sustained problem produces one finding, not one per probe', () => {
  const { qa, findings } = make({ p95LatencyMs: 50 });
  feed(qa, 'd', { good: 40, ms: 400 });
  for (let i = 0; i < 20; i++) qa.evaluate('d', 'R1');
  // 20 evaluations of an unchanging condition must still yield one finding.
  assert.equal(findings.list().filter((f) => f.kind === 'latency_tail_high').length, 1);
});

test('recovery clears the finding', () => {
  const { qa, findings } = make({ p95LatencyMs: 50 });
  feed(qa, 'd', { good: 40, ms: 400 });
  qa.evaluate('d', 'R1'); qa.evaluate('d', 'R1');
  assert.ok(findings.list().some((f) => f.kind === 'latency_tail_high'));
  // Flush the history with good probes, then re-evaluate.
  feed(qa, 'd', { good: 120, ms: 5 });
  for (let i = 0; i < 5; i++) qa.evaluate('d', 'R1');
  assert.ok(!findings.list().some((f) => f.kind === 'latency_tail_high'), 'cleared after recovery');
});

test('a rising link forecasts saturation with a time estimate', () => {
  const { qa, findings } = make();
  const t0 = Date.now();
  for (let i = 0; i < 12; i++) qa.recordUtilisation('R1', 'Gi0/0', 0.5 + i * 0.02, t0 + i * 60_000);
  const f = qa.evaluateSaturation('R1', 'Gi0/0');
  assert.ok(f, 'should forecast');
  assert.match(f.detail, /reaches 90% in about \d+ minutes/);
  assert.ok(f.evidence.secondsToSaturation > 0);
});

test('a stable link forecasts nothing', () => {
  const { qa } = make();
  const t0 = Date.now();
  for (let i = 0; i < 12; i++) qa.recordUtilisation('R1', 'Gi0/1', 0.5, t0 + i * 60_000);
  assert.equal(qa.evaluateSaturation('R1', 'Gi0/1'), null);
});
