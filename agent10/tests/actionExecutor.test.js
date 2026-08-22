const test = require('node:test');
const assert = require('node:assert');
const { ActionExecutor } = require('../src/services/actionExecutor');

function makeExecutor() {
  const config = {
    orchestrator: { base_url: 'http://localhost:8080', timeout_ms: 1000 },
    sources: { agent7_url: '', agent8_url: '', agent9_url: '', timeout_ms: 1000 },
    known_agents: ['agent1-monitoring', 'agent2-resilience']
  };
  return new ActionExecutor(config);
}

test('isValidAction: rejects anything outside the fixed registry', () => {
  const ex = makeExecutor();
  assert.strictEqual(ex.isValidAction('get_overview'), true);
  assert.strictEqual(ex.isValidAction('delete_everything'), false);
  assert.strictEqual(ex.isValidAction('__proto__'), false);
});

test('isDestructive: only start/stop/restart require confirmation', () => {
  const ex = makeExecutor();
  assert.strictEqual(ex.isDestructive('restart_agent'), true);
  assert.strictEqual(ex.isDestructive('stop_agent'), true);
  assert.strictEqual(ex.isDestructive('start_agent'), true);
  assert.strictEqual(ex.isDestructive('get_overview'), false);
  assert.strictEqual(ex.isDestructive('chat'), false);
});

test('isKnownAgent: only names from config.known_agents are valid', () => {
  const ex = makeExecutor();
  assert.strictEqual(ex.isKnownAgent('agent1-monitoring'), true);
  assert.strictEqual(ex.isKnownAgent('agent99-madeup'), false);
});
