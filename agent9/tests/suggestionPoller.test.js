const test = require('node:test');
const assert = require('node:assert');
const SuggestionPoller = require('../src/services/suggestionPoller');

function makePoller() {
  const config = { polling: { interval_seconds: 120, history_size: 30 } };
  return new SuggestionPoller(config, null);
}

test('buildCronExpr: under 60s uses seconds-field step', () => {
  const poller = makePoller();
  assert.strictEqual(poller.buildCronExpr(30), '*/30 * * * * *');
});

test('buildCronExpr: exact multiples of 60 step the minutes field', () => {
  const poller = makePoller();
  assert.strictEqual(poller.buildCronExpr(120), '0 */2 * * * *');
});

test('buildCronExpr: rejects invalid intervals', () => {
  const poller = makePoller();
  assert.throws(() => poller.buildCronExpr(90), /must be under 60, or an exact multiple of 60/);
});
