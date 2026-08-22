const { test } = require('node:test');
const assert = require('node:assert');
const PolicyChecker = require('../src/modules/policyChecker');

/** Minimal stand-in for the real listener's query surface. */
function listenerWith(messages) {
  return { getMessages: () => messages };
}
const msg = (text, minutesAgo = 0, hostname = 'r1') => ({
  message: text,
  hostname,
  timestamp: new Date(Date.now() - minutesAgo * 60000).toISOString(),
});
const router = { name: 'r1', host: 'r1' };

test('with no listener the check reports not-evaluated, never a pass', async () => {
  // The regression this replaced: returning compliant:true from a check that
  // never ran, which becomes a clean compliance report.
  const pc = new PolicyChecker({}, null);
  const r = await pc.checkSyslogPattern(router, { pattern: 'x' });
  assert.strictEqual(r.compliant, null);
  assert.strictEqual(r.verified, false);
  assert.ok(r.notEvaluated);
});

test('absent expectation: compliant when the pattern does not appear', async () => {
  const pc = new PolicyChecker({}, listenerWith([msg('everything is fine')]));
  const r = await pc.checkSyslogPattern(router, { pattern: 'LOGIN_FAILED' });
  assert.strictEqual(r.compliant, true);
  assert.strictEqual(r.verified, true);
  assert.strictEqual(r.matchCount, 0);
});

test('absent expectation: violated when the pattern appears', async () => {
  const pc = new PolicyChecker(
    {},
    listenerWith([msg('%SEC_LOGIN-4-LOGIN_FAILED: Login failed'), msg('normal')]),
  );
  const r = await pc.checkSyslogPattern(router, {
    pattern: 'LOGIN_FAILED',
    description: 'No failed logins',
  });
  assert.strictEqual(r.compliant, false);
  assert.strictEqual(r.matchCount, 1);
  assert.match(r.violation, /No failed logins/);
  assert.ok(r.sampleMatch.includes('LOGIN_FAILED'));
});

test('maxOccurrences allows a threshold rather than a binary', async () => {
  const many = Array.from({ length: 4 }, () => msg('LOGIN_FAILED'));
  const pc = new PolicyChecker({}, listenerWith(many));
  assert.strictEqual(
    (await pc.checkSyslogPattern(router, { pattern: 'LOGIN_FAILED', maxOccurrences: 5 })).compliant,
    true,
  );
  assert.strictEqual(
    (await pc.checkSyslogPattern(router, { pattern: 'LOGIN_FAILED', maxOccurrences: 3 })).compliant,
    false,
  );
});

test('present expectation inverts the test', async () => {
  const pc = new PolicyChecker(
    {},
    listenerWith([msg('LOGGINGHOST_STARTSTOP: Logging to host started')]),
  );
  const present = await pc.checkSyslogPattern(router, {
    pattern: 'LOGGINGHOST',
    expectation: 'present',
  });
  assert.strictEqual(present.compliant, true);
  const missing = await pc.checkSyslogPattern(router, {
    pattern: 'NEVER_APPEARS',
    expectation: 'present',
  });
  assert.strictEqual(missing.compliant, false);
});

test('messages outside the window are ignored', async () => {
  const pc = new PolicyChecker({}, listenerWith([msg('LOGIN_FAILED', 120)]));
  const inWindow = await pc.checkSyslogPattern(router, {
    pattern: 'LOGIN_FAILED',
    withinMinutes: 60,
  });
  assert.strictEqual(inWindow.compliant, true, '2h-old message must not count in a 60m window');
  const wider = await pc.checkSyslogPattern(router, {
    pattern: 'LOGIN_FAILED',
    withinMinutes: 180,
  });
  assert.strictEqual(wider.compliant, false);
});

test('messages from another host are ignored', async () => {
  const pc = new PolicyChecker({}, listenerWith([msg('LOGIN_FAILED', 0, 'some-other-router')]));
  const r = await pc.checkSyslogPattern(router, { pattern: 'LOGIN_FAILED' });
  assert.strictEqual(r.compliant, true);
});

test('an invalid regex is reported, not thrown', async () => {
  const pc = new PolicyChecker({}, listenerWith([msg('x')]));
  const r = await pc.checkSyslogPattern(router, { pattern: '([unclosed' });
  assert.strictEqual(r.compliant, null);
  assert.match(r.notEvaluated, /regular expression/);
});

test('a policy with no pattern is not evaluated', async () => {
  const pc = new PolicyChecker({}, listenerWith([msg('x')]));
  const r = await pc.checkSyslogPattern(router, {});
  assert.strictEqual(r.compliant, null);
});
