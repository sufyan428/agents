const { test } = require('node:test');
const assert = require('node:assert');
const { FindingStore } = require('@ragent/agent-common');
const BaselineProcessor = require('../src/processors/baselineProcessor');

const THRESHOLDS = { cpu: { warning: 75, critical: 90 } };

function makeProcessor(overrides = {}) {
  const findingStore = new FindingStore();
  const processor = new BaselineProcessor({
    findingStore,
    thresholds: THRESHOLDS,
    baselineOptions: { warmupSamples: 12, seasonal: false, ...overrides },
  });
  return { processor, findingStore };
}

/** Feeds n samples of a steady value so the baseline learns "normal". */
function warmUp(processor, entity, value, n = 30, startMs = Date.UTC(2026, 0, 1)) {
  for (let i = 0; i < n; i++) {
    processor.process(entity, 'cpu', value + (i % 3), {
      unit: '%',
      at: new Date(startMs + i * 30_000),
    });
  }
  return startMs + n * 30_000;
}

test('a configured threshold breach produces a finding', () => {
  const { processor, findingStore } = makeProcessor();
  const t = Date.UTC(2026, 0, 1);
  // raiseAfter is 2, so a single sample must not be enough.
  processor.process('R1', 'cpu', 95, { unit: '%', at: new Date(t) });
  assert.strictEqual(findingStore.activeCount, 0, 'one breach is not sustained');
  processor.process('R1', 'cpu', 95, { unit: '%', at: new Date(t + 30_000) });
  assert.strictEqual(findingStore.activeCount, 1);
  const [f] = findingStore.list();
  assert.strictEqual(f.kind, 'cpu_threshold_exceeded');
  assert.strictEqual(f.severity, 'critical');
  assert.strictEqual(f.evidence.basis, 'configured_threshold');
});

test('a sustained breach does not produce a new finding on every poll', () => {
  // The alert-storm regression, at the finding layer.
  const { processor, findingStore } = makeProcessor();
  const t = Date.UTC(2026, 0, 1);
  for (let i = 0; i < 30; i++) {
    processor.process('R1', 'cpu', 95, { unit: '%', at: new Date(t + i * 30_000) });
  }
  assert.strictEqual(findingStore.activeCount, 1, 'one condition, one finding');
});

test('recovering below the clear band resolves the finding', () => {
  const { processor, findingStore } = makeProcessor();
  const t = Date.UTC(2026, 0, 1);
  for (let i = 0; i < 3; i++)
    processor.process('R1', 'cpu', 95, { unit: '%', at: new Date(t + i * 30_000) });
  assert.strictEqual(findingStore.activeCount, 1);
  // clearAt is 90 * 0.9 = 81, and clearAfter is 3.
  for (let i = 3; i < 8; i++)
    processor.process('R1', 'cpu', 20, { unit: '%', at: new Date(t + i * 30_000) });
  assert.strictEqual(findingStore.activeCount, 0, 'condition ended, finding cleared');
});

test('a value inside the hysteresis band does not clear the finding', () => {
  const { processor, findingStore } = makeProcessor();
  const t = Date.UTC(2026, 0, 1);
  for (let i = 0; i < 3; i++)
    processor.process('R1', 'cpu', 95, { unit: '%', at: new Date(t + i * 30_000) });
  // 85 is below the 90 raise threshold but above the 81 clear threshold.
  for (let i = 3; i < 10; i++)
    processor.process('R1', 'cpu', 85, { unit: '%', at: new Date(t + i * 30_000) });
  assert.strictEqual(findingStore.activeCount, 1, 'still raised inside the band');
});

test("a departure from this device's normal is caught below every threshold", () => {
  // The case a fixed threshold cannot see: this device idles at 22%, so 60% is
  // a real event - but 60 is under both the 75 warning and 90 critical lines.
  const { processor, findingStore } = makeProcessor();
  const t = warmUp(processor, 'R1', 22);
  processor.process('R1', 'cpu', 60, { unit: '%', at: new Date(t) });
  processor.process('R1', 'cpu', 60, { unit: '%', at: new Date(t + 30_000) });

  assert.strictEqual(findingStore.activeCount, 1);
  const [f] = findingStore.list();
  assert.strictEqual(f.kind, 'cpu_baseline_anomaly');
  assert.match(f.evidence.basis, /baseline/);
  assert.ok(Math.abs(f.evidence.z) > 3.5, `z=${f.evidence.z}`);
  assert.ok(f.detail.includes('No configured threshold was crossed'));
});

test('a device that normally runs hot is not flagged for running hot', () => {
  // The mirror case: this device always sits at 78%, which a fixed warning at
  // 75 would page someone about every single poll, forever.
  const { processor, findingStore } = makeProcessor();
  const t = warmUp(processor, 'R1', 78);
  processor.process('R1', 'cpu', 79, { unit: '%', at: new Date(t) });
  processor.process('R1', 'cpu', 79, { unit: '%', at: new Date(t + 30_000) });

  // The configured warning still fires, because it is an explicit operator
  // intent - but no baseline anomaly is added on top of it.
  const baselineFindings = findingStore.list().filter((f) => f.kind.endsWith('_baseline_anomaly'));
  assert.strictEqual(baselineFindings.length, 0, 'normal for this device');
});

test('nothing is flagged as anomalous before the baseline has warmed up', () => {
  const { processor, findingStore } = makeProcessor({ warmupSamples: 20 });
  const t = Date.UTC(2026, 0, 1);
  processor.process('R1', 'cpu', 20, { unit: '%', at: new Date(t) });
  processor.process('R1', 'cpu', 70, { unit: '%', at: new Date(t + 30_000) });
  processor.process('R1', 'cpu', 70, { unit: '%', at: new Date(t + 60_000) });
  const baselineFindings = findingStore.list().filter((f) => f.kind.endsWith('_baseline_anomaly'));
  assert.strictEqual(baselineFindings.length, 0, 'no verdict before warmup');
});

test('separate routers keep separate baselines', () => {
  const { processor, findingStore } = makeProcessor();
  const t1 = warmUp(processor, 'quiet-router', 20);
  warmUp(processor, 'busy-router', 70);

  // 55% is anomalous for the quiet one and unremarkable for the busy one.
  processor.process('quiet-router', 'cpu', 55, { unit: '%', at: new Date(t1) });
  processor.process('quiet-router', 'cpu', 55, { unit: '%', at: new Date(t1 + 30_000) });
  processor.process('busy-router', 'cpu', 71, { unit: '%', at: new Date(t1) });
  processor.process('busy-router', 'cpu', 71, { unit: '%', at: new Date(t1 + 30_000) });

  const kinds = findingStore.list().map((f) => `${f.entity.id}:${f.kind}`);
  assert.ok(
    kinds.some((k) => k.startsWith('quiet-router')),
    'quiet router flagged',
  );
  assert.ok(!kinds.some((k) => k.startsWith('busy-router')), 'busy router not flagged');
});

test('a non-finite sample is ignored rather than poisoning the baseline', () => {
  const { processor } = makeProcessor();
  const before = processor.describe().trackedSeries;
  processor.process('R1', 'cpu', NaN, { unit: '%' });
  processor.process('R1', 'cpu', Infinity, { unit: '%' });
  assert.strictEqual(processor.describe().trackedSeries, before);
});

test('findings carry the evidence an operator needs to judge them', () => {
  const { processor, findingStore } = makeProcessor();
  const t = warmUp(processor, 'R1', 22);
  processor.process('R1', 'cpu', 60, { unit: '%', at: new Date(t) });
  processor.process('R1', 'cpu', 60, { unit: '%', at: new Date(t + 30_000) });
  const [f] = findingStore.list();
  assert.strictEqual(f.evidence.value, 60);
  assert.ok(typeof f.evidence.baselineExpected === 'number');
  assert.ok(typeof f.evidence.baselineSpread === 'number');
  assert.ok(f.evidence.samples > 12);
});
