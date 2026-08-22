const test = require('node:test');
const assert = require('node:assert');
const Collector = require('../src/services/collector');

test('hasAnomaly: false when everything reachable and healthy', () => {
  const snapshot = {
    orchestratorReachable: true,
    orchestrator: { agents: { a: { healthy: true, status: 'running' } } },
    agents: { agent1: { reachable: true, health: { status: 'healthy' } } }
  };
  assert.strictEqual(Collector.hasAnomaly(snapshot, null), false);
});

test('hasAnomaly: true when an agent is unreachable', () => {
  const snapshot = {
    orchestratorReachable: true,
    orchestrator: { agents: {} },
    agents: { agent1: { reachable: false } }
  };
  assert.strictEqual(Collector.hasAnomaly(snapshot, null), true);
});

test('hasAnomaly: true when orchestrator itself is unreachable', () => {
  const snapshot = { orchestratorReachable: false, orchestrator: null, agents: {} };
  assert.strictEqual(Collector.hasAnomaly(snapshot, null), true);
});

test('hasAnomaly: true when an agent status flips between snapshots', () => {
  const previous = { orchestratorReachable: true, orchestrator: { agents: { agent1: { healthy: true, status: 'running' } } }, agents: {} };
  const current = { orchestratorReachable: true, orchestrator: { agents: { agent1: { healthy: false, status: 'running' } } }, agents: {} };
  assert.strictEqual(Collector.hasAnomaly(current, previous), true);
});
