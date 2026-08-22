const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

/**
 * HTTP route tests for the orchestrator gateway.
 *
 * These cover the surface that carries the most risk in the whole framework:
 * routes that start, stop and restart agents, rewrite every downstream config,
 * and expose the master configuration. Every one of them was reachable by an
 * unauthenticated POST before Phase 2, so they are worth a test that fails
 * loudly if that ever regresses.
 *
 * The gateway is exercised over real HTTP against a real listener rather than
 * by calling handlers directly - middleware ordering is exactly where auth
 * bugs live, and calling a handler skips all of it.
 */

process.env.AGENT_API_TOKEN = 'test-token';
// config-manager resolves router.yml relative to its own directory, but the
// distribution step writes into sibling agent folders, so the process needs to
// be somewhere sane.
process.chdir(path.join(__dirname, '..'));

const configManager = require('../src/config-manager');
const agentManager = require('../src/agent-manager');
const gateway = require('../src/api-gateway');

const PORT = 18099;
const BASE = `http://127.0.0.1:${PORT}`;
const AUTH = { Authorization: 'Bearer test-token' };
const BAD = { Authorization: 'Bearer wrong-token' };

const status = async (method, path, headers) =>
  (await fetch(BASE + path, { method, headers: headers ?? {} })).status;

test.before(async () => {
  const cfg = configManager.loadMasterConfig();
  await agentManager.initializeAgents(cfg.agents);
  await gateway.start(PORT, '127.0.0.1');
});

test.after(async () => {
  await gateway.stop();
  agentManager.stopHealthMonitoring();
  // The correlation engine is a module singleton with an interval; it is never
  // started here, but stopping it is cheap insurance against a hanging suite.
  require('../src/correlation').stop();
});

/* ------------------------------ read-only -------------------------------- */

test('read-only routes need no token', async () => {
  for (const p of [
    '/health',
    '/metrics',
    '/api/agents',
    '/api/overview',
    '/api/config',
    '/api/incidents',
  ]) {
    assert.equal(await status('GET', p), 200, `GET ${p}`);
  }
});

test('an unknown agent is 404, not 500', async () => {
  assert.equal(await status('GET', '/api/agents/does-not-exist'), 404);
});

test('an unknown path is a JSON 404', async () => {
  const res = await fetch(`${BASE}/nope`);
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error, 'Not found');
});

/* -------------------------------- auth ----------------------------------- */

const CONTROL_ROUTES = [
  '/api/agents/agent1-monitoring/start',
  '/api/agents/agent1-monitoring/stop',
  '/api/agents/agent1-monitoring/restart',
  '/api/agents/agent1-monitoring/enable',
  '/api/agents/agent1-monitoring/disable',
  '/api/agents/start-all',
  '/api/agents/stop-all',
  '/api/config/reload',
];

test('every control route rejects an unauthenticated caller', async () => {
  // The Phase 2 finding: all of these were reachable by an anonymous POST.
  for (const p of CONTROL_ROUTES) {
    assert.equal(await status('POST', p), 401, `POST ${p} without a token`);
  }
});

test('every control route rejects a wrong token', async () => {
  for (const p of CONTROL_ROUTES) {
    assert.equal(await status('POST', p, BAD), 401, `POST ${p} with a bad token`);
  }
});

test('a valid token is accepted', async () => {
  // stop-all is the safe one to actually invoke: nothing is running.
  assert.equal(await status('POST', '/api/agents/stop-all', AUTH), 200);
});

/* ---------------------------- secret handling ---------------------------- */

test('no secret from router.yml reaches the wire', async () => {
  const body = await (await fetch(`${BASE}/api/config`)).json();
  assert.equal(body.config.grafana.admin_password, '[redacted]');
  assert.equal(body.config.router.primary.snmp_community, '[redacted]');
  assert.equal(body.config.router.backup.snmp_community, '[redacted]');

  // Belt and braces: the literal defaults must not appear anywhere in the
  // payload, whatever shape the config grows into later.
  const raw = JSON.stringify(body);
  assert.ok(!/"admin_password":"admin"/.test(raw));
  assert.ok(!/"snmp_community":"public"/.test(raw));
});

/* ------------------------------- hardening ------------------------------- */

test('responses carry hardening headers and no framework fingerprint', async () => {
  const res = await fetch(`${BASE}/health`);
  assert.equal(res.headers.get('x-powered-by'), null);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(res.headers.get('x-correlation-id'));
});

test('cross-origin is denied by default', async () => {
  const res = await fetch(`${BASE}/health`, { headers: { origin: 'https://evil.example' } });
  assert.equal(res.headers.get('access-control-allow-origin'), null);
});

test('an inbound correlation id is propagated, a malformed one is replaced', async () => {
  const good = await fetch(`${BASE}/health`, { headers: { 'x-correlation-id': 'trace-abc' } });
  assert.equal(good.headers.get('x-correlation-id'), 'trace-abc');

  const bad = await fetch(`${BASE}/health`, { headers: { 'x-correlation-id': 'bad id!' } });
  assert.notEqual(bad.headers.get('x-correlation-id'), 'bad id!');
});

/* ------------------------------- toggles --------------------------------- */

test('an agent can be disabled and re-enabled at runtime', async () => {
  const name = 'agent3-security';
  const read = async () => (await (await fetch(`${BASE}/api/agents/${name}`)).json()).agent;

  assert.equal((await read()).enabled, true);

  const off = await (
    await fetch(`${BASE}/api/agents/${name}/disable`, { method: 'POST', headers: AUTH })
  ).json();
  assert.equal(off.enabled, false);
  assert.equal((await read()).enabled, false);
  // A disabled agent is deliberately absent, which peers must be able to see.
  assert.equal((await read()).expected, false);

  // A disabled agent must not be startable. Checked through startAgent
  // directly rather than via start-all, because start-all would spawn every
  // other agent as a real child process - a test must not do that.
  assert.equal(agentManager.startAgent(name), false, 'a disabled agent refuses to start');
  assert.equal((await read()).status, 'stopped');

  const on = await (
    await fetch(`${BASE}/api/agents/${name}/enable`, { method: 'POST', headers: AUTH })
  ).json();
  assert.equal(on.enabled, true);
});

test('toggling an unknown agent is 404', async () => {
  assert.equal(await status('POST', '/api/agents/nope/disable', AUTH), 404);
});

/* ------------------------------- incidents ------------------------------- */

test('the incidents endpoint answers with no AI configured', async () => {
  // Correlation is deterministic and lives in the orchestrator precisely so
  // that it does not require an API key.
  const body = await (await fetch(`${BASE}/api/incidents`)).json();
  assert.equal(body.success, true);
  assert.ok(Array.isArray(body.incidents));
  assert.ok(body.stats);
});
