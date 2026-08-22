const test = require('node:test');
const assert = require('node:assert/strict');
const CorrelationEngine = require('../src/services/correlationEngine');

const CONFIG = {
  orchestrator: { base_url: 'http://127.0.0.1:1', timeout_ms: 100 },
  correlation: { poll_interval_seconds: 60, history_size: 10 },
  agents: [],
};

/** A model that records what it was asked and returns a fixed narration. */
function fakeLlm(text = 'The primary router is unreachable; everything else follows from that.') {
  const calls = [];
  return {
    calls,
    async complete(system, user) {
      calls.push({ system, user });
      return text === null ? null : { text, usage: { inputTokens: 10, outputTokens: 5 }, model: 'fake' };
    },
  };
}

const incident = (over = {}) => ({
  id: 'incident-1',
  entity: '10.0.0.1',
  severity: 'critical',
  confidence: 0.85,
  simulated: false,
  reasoning: 'device_unreachable is the deepest finding in this cluster.',
  rootCause: { agent: 'agent2-resilience', kind: 'device_unreachable', title: 'Device unreachable', severity: 'critical' },
  symptoms: [
    { agent: 'agent1-monitoring', kind: 'snmp_timeout', title: 'SNMP timeout', severity: 'high' },
    { agent: 'agent4-performance', kind: 'latency_high', title: 'Latency high', severity: 'medium' },
  ],
  ...over,
});

function engineWith(incidents, llm) {
  const e = new CorrelationEngine(CONFIG, llm);
  e.collector.fetchIncidents = async () => incidents;
  e.collector.collect = async () => ({ agents: {}, orchestratorReachable: true });
  return e;
}

test('an incident is narrated and the deterministic result carried through verbatim', async () => {
  const llm = fakeLlm();
  const e = engineWith([incident()], llm);
  await e.tick();

  const r = e.getLatestResult();
  assert.ok(r, 'should produce a result');
  assert.equal(r.narrative, 'The primary router is unreachable; everything else follows from that.');
  // The computed part must survive alongside the prose, so a consumer can see
  // what was derived versus what was written.
  assert.equal(r.incidents[0].rootCause.kind, 'device_unreachable');
  assert.equal(r.incidents[0].confidence, 0.85);
  assert.match(r.incidents[0].reasoning, /deepest finding/);
});

test('an unchanged incident is not re-narrated on every cycle', async () => {
  // Re-describing the same ongoing problem costs a model call and says nothing
  // new. Only a change in the incident set is worth fresh prose.
  const llm = fakeLlm();
  const e = engineWith([incident()], llm);
  for (let i = 0; i < 5; i++) await e.tick();
  assert.equal(llm.calls.length, 1, `one call, got ${llm.calls.length}`);
  assert.equal(e.getMetrics().narrationsSkipped, 4);
});

test('a changed incident set is narrated again', async () => {
  const llm = fakeLlm();
  const e = engineWith([incident()], llm);
  await e.tick();
  e.collector.fetchIncidents = async () => [incident({ symptoms: [
    { agent: 'a', kind: 'x', title: 'X', severity: 'low' },
    { agent: 'b', kind: 'y', title: 'Y', severity: 'low' },
    { agent: 'c', kind: 'z', title: 'Z', severity: 'low' },
  ] })];
  await e.tick();
  assert.equal(llm.calls.length, 2);
});

test('an incident with no symptoms is not worth narrating', async () => {
  const llm = fakeLlm();
  const e = engineWith([incident({ symptoms: [] })], llm);
  await e.tick();
  assert.equal(llm.calls.length, 0);
  assert.equal(e.getLatestResult(), null);
});

test('no incidents means no model call', async () => {
  const llm = fakeLlm();
  const e = engineWith([], llm);
  await e.tick();
  assert.equal(llm.calls.length, 0);
});

test('a model failure loses the prose, never the incident', async () => {
  // The whole point of correlating deterministically: the AI layer being
  // unavailable must not remove information.
  const llm = fakeLlm(null);
  const e = engineWith([incident()], llm);
  await e.tick();
  assert.equal(e.getLatestResult(), null, 'no narration');
  assert.equal(e.getMetrics().llmErrorsTotal, 1);
  // The next tick retries rather than treating the failure as "already done".
  await e.tick();
  assert.equal(llm.calls.length, 2);
});

test('the orchestrator being unreachable is handled, not thrown', async () => {
  const llm = fakeLlm();
  const e = engineWith(null, llm);
  await assert.doesNotReject(() => e.tick());
  assert.equal(llm.calls.length, 0);
});

test('simulated input is flagged on the result and in the prompt', async () => {
  const llm = fakeLlm();
  const e = engineWith([incident({ simulated: true })], llm);
  await e.tick();
  assert.equal(e.getLatestResult().simulated, true);
  assert.match(llm.calls[0].user, /"simulated": true/);
  // The system prompt must instruct the model to surface it.
  assert.match(llm.calls[0].system, /simulated/i);
});

test('the prompt forbids re-doing the correlation', async () => {
  const llm = fakeLlm();
  const e = engineWith([incident()], llm);
  await e.tick();
  assert.match(llm.calls[0].system, /ALREADY been correlated/);
  assert.match(llm.calls[0].system, /not yours to redo/);
});

test('signatures ignore timing but track composition', () => {
  const a = [incident()];
  const b = [incident()];
  assert.equal(CorrelationEngine.signatureOf(a), CorrelationEngine.signatureOf(b));
  const c = [incident({ severity: 'high' })];
  assert.notEqual(CorrelationEngine.signatureOf(a), CorrelationEngine.signatureOf(c));
});

test('buildCronExpr rejects intervals it cannot express', () => {
  const e = new CorrelationEngine(CONFIG, fakeLlm());
  assert.equal(e.buildCronExpr(30), '*/30 * * * * *');
  assert.equal(e.buildCronExpr(120), '0 */2 * * * *');
  assert.throws(() => e.buildCronExpr(90));
});
