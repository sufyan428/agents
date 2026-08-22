import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createFinding,
  mergeFinding,
  dedupeKeyFor,
  newFindingId,
  compareSeverity,
  isAtLeast,
  buildHealthReport,
  rollUpStatus,
  healthHttpStatus,
  envelope,
  AgentEventSchema,
} from './index';

const entity = { type: 'router', id: '192.168.1.1', name: 'Primary' };

function sample(overrides: Record<string, unknown> = {}) {
  return createFinding({
    agent: 'agent1-monitoring',
    kind: 'cpu_threshold_exceeded',
    severity: 'high',
    entity,
    title: 'CPU above threshold',
    ...overrides,
  } as never);
}

test('createFinding fills identity, timestamps and defaults', () => {
  const f = sample();
  assert.equal(f.count, 1);
  assert.equal(f.simulated, false);
  assert.deepEqual(f.evidence, {});
  assert.deepEqual(f.tags, []);
  assert.equal(f.firstSeen, f.lastSeen);
  assert.equal(f.dedupeKey, dedupeKeyFor('agent1-monitoring', 'cpu_threshold_exceeded', entity));
});

test('kind must be lower_snake_case', () => {
  assert.throws(() => sample({ kind: 'CPU Threshold' }));
  assert.throws(() => sample({ kind: 'cpu-threshold' }));
  assert.doesNotThrow(() => sample({ kind: 'cpu_threshold_2' }));
});

test('finding ids do not collide within the same millisecond', () => {
  const ids = new Set(Array.from({ length: 500 }, () => newFindingId()));
  assert.equal(ids.size, 500);
});

test('severity comparison and threshold test', () => {
  assert.ok(compareSeverity('critical', 'info') > 0);
  assert.ok(compareSeverity('low', 'high') < 0);
  assert.equal(compareSeverity('medium', 'medium'), 0);
  assert.ok(isAtLeast('high', 'medium'));
  assert.ok(isAtLeast('medium', 'medium'));
  assert.ok(!isAtLeast('low', 'medium'));
});

test('mergeFinding keeps firstSeen, advances lastSeen, increments count', () => {
  const a = createFinding(
    { agent: 'a', kind: 'k', severity: 'low', entity, title: 't' } as never,
    new Date('2026-01-01T00:00:00.000Z'),
  );
  const b = createFinding(
    { agent: 'a', kind: 'k', severity: 'low', entity, title: 't' } as never,
    new Date('2026-01-01T00:05:00.000Z'),
  );
  const m = mergeFinding(a, b);
  assert.equal(m.firstSeen, '2026-01-01T00:00:00.000Z');
  assert.equal(m.lastSeen, '2026-01-01T00:05:00.000Z');
  assert.equal(m.count, 2);
});

test('mergeFinding escalates severity but never de-escalates', () => {
  const low = sample({ severity: 'low' });
  const crit = sample({ severity: 'critical' });
  assert.equal(mergeFinding(low, crit).severity, 'critical');
  assert.equal(mergeFinding(crit, low).severity, 'critical');
});

test('the simulated flag is sticky once set', () => {
  const real = sample({ simulated: false });
  const fake = sample({ simulated: true });
  assert.equal(mergeFinding(real, fake).simulated, true);
  assert.equal(mergeFinding(fake, real).simulated, true);
});

test('rollUpStatus takes the worst check', () => {
  assert.equal(rollUpStatus([]), 'healthy');
  assert.equal(rollUpStatus([{ name: 'a', status: 'healthy', simulated: false }]), 'healthy');
  assert.equal(
    rollUpStatus([
      { name: 'a', status: 'healthy', simulated: false },
      { name: 'b', status: 'degraded', simulated: false },
    ]),
    'degraded',
  );
  assert.equal(
    rollUpStatus([
      { name: 'a', status: 'degraded', simulated: false },
      { name: 'b', status: 'unhealthy', simulated: false },
    ]),
    'unhealthy',
  );
});

test('degraded is a 200 - an unreachable device must not trigger a restart', () => {
  assert.equal(healthHttpStatus('healthy'), 200);
  assert.equal(healthHttpStatus('degraded'), 200);
  assert.equal(healthHttpStatus('unhealthy'), 503);
});

test('buildHealthReport marks simulated when any check is simulated', () => {
  const r = buildHealthReport({
    agent: 'agent5-automation',
    uptimeSeconds: 10,
    checks: [
      { name: 'real', status: 'healthy', simulated: false },
      { name: 'stub', status: 'healthy', simulated: true },
    ],
  });
  assert.equal(r.simulated, true);
  assert.equal(r.status, 'healthy');
});

test('envelope propagates a supplied correlationId instead of minting one', () => {
  const f = sample();
  const first = envelope('finding', 'agent1-monitoring', f);
  const second = envelope('finding', 'agent7-correlation', f, first.correlationId);
  assert.equal(second.correlationId, first.correlationId);
  assert.notEqual(second.id, first.id);
});

test('envelope without a correlationId starts a new trace', () => {
  const a = envelope('finding', 'x', sample());
  const b = envelope('finding', 'x', sample());
  assert.notEqual(a.correlationId, b.correlationId);
});

test('AgentEventSchema rejects an unknown event type', () => {
  assert.throws(() =>
    AgentEventSchema.parse({
      id: 'e-1', source: 's', ts: new Date().toISOString(),
      correlationId: 'c-1', v: 1, type: 'nope', payload: {},
    }),
  );
});
