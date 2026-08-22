const test = require('node:test');
const assert = require('node:assert');
const RemediationAdvisor = require('../src/services/remediationAdvisor');

function makeAdvisor(historySize) {
  const config = { polling: { interval_seconds: 120, history_size: historySize } };
  return new RemediationAdvisor(config, null, null);
}

test('record: entries always carry the suggest-only safety flags', () => {
  const advisor = makeAdvisor(30);
  const entry = advisor.record('review', 'looks safe', { total_tokens: 10 });
  assert.strictEqual(entry.requiresHumanApproval, true);
  assert.strictEqual(entry.autoApply, false);
  assert.strictEqual(entry.text, 'looks safe');
});

test('record: trims history to the configured size', () => {
  const advisor = makeAdvisor(3);
  for (let i = 0; i < 5; i++) {
    advisor.record('suggestion', `entry ${i}`, null);
  }
  assert.strictEqual(advisor.getHistory().length, 3);
  assert.strictEqual(advisor.getLatest().text, 'entry 4');
});
