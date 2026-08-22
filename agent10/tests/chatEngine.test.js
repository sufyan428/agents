const test = require('node:test');
const assert = require('node:assert');
const ChatEngine = require('../src/services/chatEngine');

function makeEngine() {
  const config = { known_agents: ['agent1-monitoring', 'agent2-resilience'] };
  return new ChatEngine(config, null, null);
}

test('parseIntent: parses clean JSON', () => {
  const engine = makeEngine();
  const result = engine.parseIntent('{"action": "get_overview", "agentName": null, "reply": "checking"}');
  assert.strictEqual(result.action, 'get_overview');
});

test('parseIntent: extracts JSON from a markdown code fence', () => {
  const engine = makeEngine();
  const text = '```json\n{"action": "chat", "agentName": null, "reply": "hi"}\n```';
  const result = engine.parseIntent(text);
  assert.strictEqual(result.action, 'chat');
});

test('parseIntent: extracts JSON embedded in surrounding prose', () => {
  const engine = makeEngine();
  const text = 'Sure, here you go: {"action": "get_incidents", "agentName": null, "reply": "ok"} hope that helps!';
  const result = engine.parseIntent(text);
  assert.strictEqual(result.action, 'get_incidents');
});

test('parseIntent: returns null for text with no parseable JSON', () => {
  const engine = makeEngine();
  assert.strictEqual(engine.parseIntent('just a plain sentence with no json at all'), null);
});

test('parseIntent: returns null for empty input', () => {
  const engine = makeEngine();
  assert.strictEqual(engine.parseIntent(''), null);
  assert.strictEqual(engine.parseIntent(null), null);
});
