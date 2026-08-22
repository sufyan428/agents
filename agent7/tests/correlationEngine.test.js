const test = require('node:test');
const assert = require('node:assert');
const CorrelationEngine = require('../src/services/correlationEngine');

function makeEngine() {
  const config = {
    correlation: { poll_interval_seconds: 60, history_size: 30, anomaly_only: true, baseline_every_n_polls: 30 },
    agents: [],
    orchestrator: { base_url: 'http://localhost:8080', timeout_ms: 1000 }
  };
  return new CorrelationEngine(config, null);
}

test('buildCronExpr: under 60s uses seconds-field step', () => {
  const engine = makeEngine();
  assert.strictEqual(engine.buildCronExpr(30), '*/30 * * * * *');
  assert.strictEqual(engine.buildCronExpr(1), '*/1 * * * * *');
});

test('buildCronExpr: exact multiples of 60 step the minutes field', () => {
  const engine = makeEngine();
  assert.strictEqual(engine.buildCronExpr(60), '0 */1 * * * *');
  assert.strictEqual(engine.buildCronExpr(120), '0 */2 * * * *');
  assert.strictEqual(engine.buildCronExpr(300), '0 */5 * * * *');
});

test('buildCronExpr: rejects intervals that are neither under 60 nor a clean multiple of 60', () => {
  const engine = makeEngine();
  assert.throws(() => engine.buildCronExpr(90), /must be under 60, or an exact multiple of 60/);
  assert.throws(() => engine.buildCronExpr(150), /must be under 60, or an exact multiple of 60/);
});
