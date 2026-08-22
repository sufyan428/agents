import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';
import { createServer } from './server';
import { createLogger, redact, redactText } from './logger';
import { loadConfig, applyEnvMap, setPath, ConfigError, ServerConfigSchema } from './config';
import {
  declareSimulated,
  markSimulated,
  simulatedPaths,
  usedSimulatedPaths,
  simulationHealthCheck,
  resetSimulationRegistry,
} from './simulation';
import { FindingStore } from './findings';
import { Store } from './store';
import { withTrace, currentCorrelationId, traceHeaders, instrumentAxios } from './tracing';
import { createFinding } from '@ragent/agent-protocol';

/* -------------------------------- logging -------------------------------- */

test('redact masks secret-looking keys at any depth', () => {
  const out = redact({
    host: '10.0.0.1',
    snmp_community: 'public',
    nested: { SMTP_PASS: 'hunter2', apiKey: 'sk-abc', port: 161 },
    list: [{ password: 'x' }],
  }) as Record<string, any>;

  assert.equal(out.host, '10.0.0.1');
  assert.equal(out.port, undefined);
  assert.equal(out.snmp_community, '[redacted]');
  assert.equal(out.nested.SMTP_PASS, '[redacted]');
  assert.equal(out.nested.apiKey, '[redacted]');
  assert.equal(out.nested.port, 161);
  assert.equal(out.list[0].password, '[redacted]');
});

test('redact survives a cycle instead of overflowing the stack', () => {
  const a: Record<string, unknown> = { name: 'a' };
  a.self = a;
  const out = redact(a) as Record<string, unknown>;
  assert.equal(out.self, '[circular]');
});

test('redactText masks keys and bearer tokens inside free text', () => {
  assert.match(redactText('key is sk-or-v1-abcdef123456 ok'), /\[redacted\]/);
  assert.ok(!redactText('key is sk-or-v1-abcdef123456').includes('abcdef123456'));
  assert.match(redactText('Authorization: Bearer abc.def-ghi'), /Bearer \[redacted\]/);
});

/* --------------------------------- config -------------------------------- */

function tmpYaml(body: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ragent-cfg-'));
  const file = path.join(dir, 'config.yml');
  fs.writeFileSync(file, body, 'utf8');
  return file;
}

const Schema = z.object({
  server: ServerConfigSchema,
  router: z.object({ host: z.string(), community: z.string() }),
});

test('loads and validates a good config, applying schema defaults', () => {
  const file = tmpYaml('server:\n  port: 9090\nrouter:\n  host: 10.0.0.1\n  community: public\n');
  const cfg = loadConfig({ file, schema: Schema });
  assert.equal(cfg.server.port, 9090);
  assert.equal(cfg.server.host, '127.0.0.1', 'must default to loopback');
  assert.equal(cfg.server.health_path, '/health');
});

test('a missing key names the exact path instead of a TypeError', () => {
  const file = tmpYaml('server:\n  port: 9090\nrouter:\n  host: 10.0.0.1\n');
  try {
    loadConfig({ file, schema: Schema });
    assert.fail('should have thrown');
  } catch (err) {
    assert.ok(err instanceof ConfigError);
    assert.match(err.message, /router\.community/);
    assert.match(err.message, /required, but missing/);
  }
});

test('a missing file explains itself', () => {
  try {
    loadConfig({ file: path.join(os.tmpdir(), 'definitely-not-here.yml'), schema: Schema });
    assert.fail('should have thrown');
  } catch (err) {
    assert.ok(err instanceof ConfigError);
    assert.match(err.message, /not found/);
  }
});

test('malformed YAML is reported as a config error, not a raw parser dump', () => {
  const file = tmpYaml('server:\n  port: 9090\n bad indent here\n');
  assert.throws(() => loadConfig({ file, schema: Schema }), ConfigError);
});

test('env overrides are coerced to the right type', () => {
  const target: Record<string, unknown> = {};
  applyEnvMap(target, { PORT: 'server.port', DEBUG: 'flags.debug', RATIO: 'tune.ratio' }, {
    PORT: '9090',
    DEBUG: 'true',
    RATIO: '0.25',
  } as NodeJS.ProcessEnv);
  assert.equal((target.server as any).port, 9090);
  assert.equal(typeof (target.server as any).port, 'number');
  assert.equal((target.flags as any).debug, true);
  assert.equal((target.tune as any).ratio, 0.25);
});

test('an empty env var does not clobber the file value', () => {
  const target: Record<string, unknown> = { server: { port: 1234 } };
  applyEnvMap(target, { PORT: 'server.port' }, { PORT: '' } as NodeJS.ProcessEnv);
  assert.equal((target.server as any).port, 1234);
});

test('setPath creates intermediate objects', () => {
  const t: Record<string, unknown> = {};
  setPath(t, 'a.b.c', 1);
  assert.equal((t.a as any).b.c, 1);
});

/* --------------------------------- server -------------------------------- */

const silent = createLogger({ agent: 'test', level: 'error', format: 'json' });

async function withServer(
  opts: Parameters<typeof createServer>[0],
  attach: (s: ReturnType<typeof createServer>) => void,
  run: (base: string) => Promise<void>,
): Promise<void> {
  const s = createServer({ ...opts, port: 0, logger: silent });
  attach(s);
  const http = await s.listen();
  const { port } = http.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await s.close();
  }
}

const base = { agent: 'test-agent', port: 0, logger: silent };

test('GET requests do not require a token', async () => {
  await withServer(
    { ...base, authToken: 'secret' },
    (s) =>
      s.app.get('/data', (_q, r) => {
        r.json({ ok: true });
      }),
    async (url) => {
      const res = await fetch(`${url}/data`);
      assert.equal(res.status, 200);
    },
  );
});

test('a mutating request without a token is 401', async () => {
  await withServer(
    { ...base, authToken: 'secret' },
    (s) =>
      s.app.post('/stop', (_q, r) => {
        r.json({ stopped: true });
      }),
    async (url) => {
      const res = await fetch(`${url}/stop`, { method: 'POST' });
      assert.equal(res.status, 401);
    },
  );
});

test('a mutating request with a wrong token is 401', async () => {
  await withServer(
    { ...base, authToken: 'secret' },
    (s) =>
      s.app.post('/stop', (_q, r) => {
        r.json({ stopped: true });
      }),
    async (url) => {
      const res = await fetch(`${url}/stop`, {
        method: 'POST',
        headers: { authorization: 'Bearer wrong' },
      });
      assert.equal(res.status, 401);
    },
  );
});

test('a mutating request with the right token succeeds', async () => {
  await withServer(
    { ...base, authToken: 'secret' },
    (s) =>
      s.app.post('/stop', (_q, r) => {
        r.json({ stopped: true });
      }),
    async (url) => {
      const res = await fetch(`${url}/stop`, {
        method: 'POST',
        headers: { authorization: 'Bearer secret' },
      });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { stopped: true });
    },
  );
});

test('with NO token configured, mutating routes fail closed with 503', async () => {
  // The whole point: an unconfigured deployment must not leave agent-stopping
  // and failover-triggering endpoints wide open.
  await withServer(
    { ...base },
    (s) =>
      s.app.post('/failover', (_q, r) => {
        r.json({ triggered: true });
      }),
    async (url) => {
      const res = await fetch(`${url}/failover`, { method: 'POST' });
      assert.equal(res.status, 503);
      const body = (await res.json()) as { error: string };
      assert.match(body.error, /AGENT_API_TOKEN/);
    },
  );
});

test('publicPaths bypass auth for mutating methods', async () => {
  await withServer(
    { ...base, authToken: 'secret', publicPaths: ['/webhook'] },
    (s) =>
      s.app.post('/webhook', (_q, r) => {
        r.json({ ok: true });
      }),
    async (url) => {
      const res = await fetch(`${url}/webhook`, { method: 'POST' });
      assert.equal(res.status, 200);
    },
  );
});

test('health returns 200 when healthy and 503 only when unhealthy', async () => {
  await withServer(
    { ...base, healthChecks: () => [{ name: 'x', status: 'healthy', simulated: false }] },
    () => {},
    async (url) => {
      const res = await fetch(`${url}/health`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { status: string };
      assert.equal(body.status, 'healthy');
    },
  );

  await withServer(
    { ...base, healthChecks: () => [{ name: 'device', status: 'degraded', simulated: false }] },
    () => {},
    async (url) => {
      const res = await fetch(`${url}/health`);
      assert.equal(res.status, 200, 'a degraded device must not look like a dead process');
    },
  );

  await withServer(
    { ...base, healthChecks: () => [{ name: 'core', status: 'unhealthy', simulated: false }] },
    () => {},
    async (url) => {
      assert.equal((await fetch(`${url}/health`)).status, 503);
    },
  );
});

test('metrics endpoint serves Prometheus text', async () => {
  await withServer(
    { ...base },
    () => {},
    async (url) => {
      const res = await fetch(`${url}/metrics`);
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type') ?? '', /text\/plain/);
      assert.match(await res.text(), /process_cpu_user_seconds_total|nodejs_/);
    },
  );
});

test('an unknown path is a JSON 404, not an HTML stack page', async () => {
  await withServer(
    { ...base },
    () => {},
    async (url) => {
      const res = await fetch(`${url}/nope`);
      assert.equal(res.status, 404);
      const body = (await res.json()) as { error: string };
      assert.equal(body.error, 'Not found');
    },
  );
});

test('a thrown error returns an opaque 500 with a correlation id, never internals', async () => {
  await withServer(
    { ...base },
    (s) =>
      s.app.get('/boom', () => {
        throw new Error('secret internal detail at /srv/app/x.js');
      }),
    async (url) => {
      const res = await fetch(`${url}/boom`);
      assert.equal(res.status, 500);
      const text = await res.text();
      assert.ok(!text.includes('secret internal detail'), 'must not leak the message');
      assert.ok(!text.includes('/srv/app'), 'must not leak paths');
      const body = JSON.parse(text) as { correlationId: string };
      assert.ok(body.correlationId, 'must give the operator something to grep for');
    },
  );
});

test('an inbound correlation id is propagated rather than replaced', async () => {
  await withServer(
    { ...base },
    () => {},
    async (url) => {
      const res = await fetch(`${url}/health`, { headers: { 'x-correlation-id': 'trace-123' } });
      assert.equal(res.headers.get('x-correlation-id'), 'trace-123');
    },
  );
});

test('a malformed inbound correlation id is replaced, not trusted', async () => {
  await withServer(
    { ...base },
    () => {},
    async (url) => {
      const res = await fetch(`${url}/health`, {
        headers: { 'x-correlation-id': 'bad id with spaces!' },
      });
      const cid = res.headers.get('x-correlation-id') ?? '';
      assert.notEqual(cid, 'bad id with spaces!');
      assert.match(cid, /^c-/);
    },
  );
});

test('cross-origin is denied by default', async () => {
  await withServer(
    { ...base },
    () => {},
    async (url) => {
      const res = await fetch(`${url}/health`, { headers: { origin: 'https://evil.example' } });
      assert.equal(res.headers.get('access-control-allow-origin'), null);
    },
  );
});

test('a configured origin is allowed', async () => {
  await withServer(
    { ...base, corsOrigins: ['https://ops.example'] },
    () => {},
    async (url) => {
      const res = await fetch(`${url}/health`, { headers: { origin: 'https://ops.example' } });
      assert.equal(res.headers.get('access-control-allow-origin'), 'https://ops.example');
    },
  );
});

test('helmet headers are present and the express fingerprint is gone', async () => {
  await withServer(
    { ...base },
    () => {},
    async (url) => {
      const res = await fetch(`${url}/health`);
      assert.equal(res.headers.get('x-powered-by'), null);
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    },
  );
});

test('an oversized body is rejected', async () => {
  await withServer(
    { ...base, authToken: 't', bodyLimit: '1kb' },
    (s) =>
      s.app.post('/ingest', (_q, r) => {
        r.json({ ok: true });
      }),
    async (url) => {
      const res = await fetch(`${url}/ingest`, {
        method: 'POST',
        headers: { authorization: 'Bearer t', 'content-type': 'application/json' },
        body: JSON.stringify({ blob: 'x'.repeat(5000) }),
      });
      assert.equal(res.status, 413);
    },
  );
});

test('close() is idempotent and safe to call twice', async () => {
  const s = createServer({ agent: 'x', port: 0, logger: silent });
  await s.listen();
  await s.close();
  await s.close(); // must not throw or hang
  assert.ok(true);
});

/* ------------------------------ simulation ------------------------------- */

test('a declared simulated path is visible before it is ever called', () => {
  resetSimulationRegistry();
  declareSimulated('agentX.doThing', 'pretends to do a thing.', 'a real device');
  const paths = simulatedPaths();
  assert.equal(paths.length, 1);
  assert.equal(paths[0]?.invocations, 0);
  // Health must already report it - an operator should not have to trigger a
  // fake path to discover it exists.
  assert.equal(simulationHealthCheck('agentX').status, 'degraded');
  assert.equal(simulationHealthCheck('agentX').simulated, true);
});

test('markSimulated returns a marker the caller spreads into its result', () => {
  resetSimulationRegistry();
  declareSimulated('agentX.doThing', 'pretends.', 'NETCONF');
  const result = { ...markSimulated('agentX.doThing'), success: true };
  assert.equal(result.simulated, true);
  assert.equal(result.simulatedPath, 'agentX.doThing');
  assert.equal(result.simulatedReason, 'NETCONF');
});

test('it warns once, not on every invocation', () => {
  resetSimulationRegistry();
  declareSimulated('agentX.doThing', 'pretends.', 'NETCONF');
  const warnings: string[] = [];
  const log = { warn: (m: string) => warnings.push(m) };
  for (let i = 0; i < 5; i++) markSimulated('agentX.doThing', log);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? '', /SIMULATED/);
  assert.equal(simulatedPaths()[0]?.invocations, 5);
});

test('an agent with no simulated paths reports healthy', () => {
  resetSimulationRegistry();
  declareSimulated('agentX.thing', 'x', 'y');
  const check = simulationHealthCheck('agentY');
  assert.equal(check.status, 'healthy');
  assert.equal(check.simulated, false);
});

test('usedSimulatedPaths only lists paths actually exercised', () => {
  resetSimulationRegistry();
  declareSimulated('a.one', 'x', 'y');
  declareSimulated('a.two', 'x', 'y');
  markSimulated('a.one');
  assert.equal(usedSimulatedPaths().length, 1);
  assert.equal(usedSimulatedPaths()[0]?.id, 'a.one');
});

/* -------------------------------- findings ------------------------------- */

const sampleFinding = (over: Record<string, unknown> = {}) => ({
  agent: 'agent1-monitoring',
  kind: 'cpu_threshold_exceeded',
  severity: 'high' as const,
  entity: { type: 'router', id: '10.0.0.1', name: 'R1' },
  title: 'CPU above baseline',
  ...over,
});

test('a recurring condition updates one finding rather than creating many', () => {
  // Without this the correlation engine downstream sees a thousand findings
  // for one ongoing problem and groups noise instead of incidents.
  const store = new FindingStore();
  const first = store.report(sampleFinding());
  assert.equal(first.isNew, true);
  for (let i = 0; i < 20; i++) store.report(sampleFinding());
  assert.equal(store.activeCount, 1);
  assert.equal(store.list()[0]?.count, 21);
});

test('different entities and kinds are tracked separately', () => {
  const store = new FindingStore();
  store.report(sampleFinding());
  store.report(sampleFinding({ kind: 'memory_threshold_exceeded' }));
  store.report(sampleFinding({ entity: { type: 'router', id: '10.0.0.2' } }));
  assert.equal(store.activeCount, 3);
});

test('severity escalates on the existing finding but never de-escalates', () => {
  const store = new FindingStore();
  store.report(sampleFinding({ severity: 'medium' }));
  store.report(sampleFinding({ severity: 'critical' }));
  assert.equal(store.list()[0]?.severity, 'critical');
  store.report(sampleFinding({ severity: 'low' }));
  assert.equal(store.list()[0]?.severity, 'critical', 'must not silently downgrade');
});

test('an explicit clear resolves the finding and records duration', () => {
  const store = new FindingStore();
  const t0 = new Date('2026-01-01T00:00:00Z');
  store.report(sampleFinding(), t0);
  const cleared = store.clear(
    'agent1-monitoring',
    'cpu_threshold_exceeded',
    { type: 'router', id: '10.0.0.1' },
    'recovered',
    new Date('2026-01-01T00:05:00Z'),
  );
  assert.equal(cleared, true);
  assert.equal(store.activeCount, 0);
  const [res] = store.recentlyResolved();
  assert.equal(res?.reason, 'recovered');
  assert.equal(res?.durationMs, 300_000);
});

test('sweep resolves findings that stopped recurring, and only those', () => {
  const store = new FindingStore({ resolveAfterMs: 300_000 });
  const t0 = new Date('2026-01-01T00:00:00Z');
  store.report(sampleFinding(), t0);
  store.report(sampleFinding({ kind: 'link_down' }), t0);

  // One keeps recurring, the other goes quiet.
  const t4 = new Date('2026-01-01T00:04:00Z');
  store.report(sampleFinding({ kind: 'link_down' }), t4);

  const resolved = store.sweep(new Date('2026-01-01T00:06:00Z'));
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0]?.finding.kind, 'cpu_threshold_exceeded');
  assert.equal(store.activeCount, 1, 'the still-recurring one stays active');
});

test('the store is bounded', () => {
  const store = new FindingStore({ maxActive: 10 });
  for (let i = 0; i < 50; i++) {
    store.report(sampleFinding({ entity: { type: 'router', id: `10.0.0.${i}` } }));
  }
  assert.ok(store.activeCount <= 10);
});

test('listing sorts by severity and filters by a floor', () => {
  const store = new FindingStore();
  store.report(sampleFinding({ kind: 'a', severity: 'low' }));
  store.report(sampleFinding({ kind: 'b', severity: 'critical' }));
  store.report(sampleFinding({ kind: 'c', severity: 'medium' }));
  assert.equal(store.list()[0]?.severity, 'critical');
  assert.equal(store.list('medium').length, 2);
});

test('a simulated finding marks the whole store', () => {
  const store = new FindingStore();
  store.report(sampleFinding());
  assert.equal(store.hasSimulated, false);
  store.report(sampleFinding({ kind: 'qos_violation', simulated: true }));
  assert.equal(store.hasSimulated, true);
  assert.equal(store.summary().simulated, true);
});

/* ---------------------------------- store -------------------------------- */

const storeFinding = (over: Record<string, unknown> = {}) =>
  createFinding({
    agent: 'agent1-monitoring',
    kind: 'cpu_threshold_exceeded',
    severity: 'high',
    entity: { type: 'router', id: '10.0.0.1', name: 'R1' },
    title: 'CPU high',
    ...over,
  } as never);

test('a finding survives being written and read back', () => {
  const s = new Store({ file: ':memory:' });
  assert.equal(s.available, true);
  s.saveFinding(storeFinding());
  const rows = s.recentFindings();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.kind, 'cpu_threshold_exceeded');
  assert.equal(rows[0]?.simulated, 0);
  s.close();
});

test('re-saving the same finding updates it rather than duplicating', () => {
  const s = new Store({ file: ':memory:' });
  const f = storeFinding();
  s.saveFinding(f);
  s.saveFinding({ ...f, count: 7, lastSeen: new Date(Date.now() + 60_000).toISOString() });
  const rows = s.recentFindings();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.count, 7);
  s.close();
});

test('history answers "has this happened before"', () => {
  // The question an operator actually asks, and one the framework could not
  // answer at all while everything lived in memory.
  const s = new Store({ file: ':memory:' });
  for (let i = 0; i < 3; i++) {
    s.saveFinding(storeFinding({}));
  }
  const f = storeFinding();
  s.saveFinding(f);
  const h = s.historyFor(f.dedupeKey);
  assert.ok(h.occurrences >= 1);
  assert.ok(h.firstEver);
  s.close();
});

test('resolution is recorded against the open finding only', () => {
  const s = new Store({ file: ':memory:' });
  const f = storeFinding();
  s.saveFinding(f);
  s.markFindingResolved(f.dedupeKey, 'recovered');
  const row = s.recentFindings()[0] as Record<string, unknown>;
  assert.equal(row.resolve_reason, 'recovered');
  assert.ok(row.resolved_at);
  s.close();
});

test('incidents persist and update in place', () => {
  const s = new Store({ file: ':memory:' });
  const base = {
    id: 'incident-1',
    entity: 'R1',
    severity: 'critical',
    rootCauseKind: 'device_unreachable',
    rootCauseTitle: 'Unreachable',
    findingCount: 3,
    agents: ['agent1', 'agent2'],
    confidence: 0.8,
    simulated: false,
    startedAt: '2026-01-01T00:00:00Z',
    lastActivityAt: '2026-01-01T00:01:00Z',
  };
  s.saveIncident(base);
  s.saveIncident({
    ...base,
    findingCount: 5,
    lastActivityAt: '2026-01-01T00:05:00Z',
    narrative: 'Power loss.',
  });
  const rows = s.recentIncidents();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.finding_count, 5);
  assert.equal(rows[0]?.narrative, 'Power loss.');
  s.close();
});

test('a later save without a narrative does not erase one already stored', () => {
  const s = new Store({ file: ':memory:' });
  const base = {
    id: 'i1',
    entity: 'R1',
    severity: 'high',
    rootCauseKind: 'k',
    rootCauseTitle: 't',
    findingCount: 1,
    agents: [],
    confidence: 0.5,
    simulated: false,
    startedAt: '2026-01-01T00:00:00Z',
    lastActivityAt: '2026-01-01T00:00:00Z',
  };
  s.saveIncident({ ...base, narrative: 'Written by the AI layer.' });
  s.saveIncident(base); // a later deterministic-only pass
  assert.equal(s.recentIncidents()[0]?.narrative, 'Written by the AI layer.');
  s.close();
});

test('tables stay bounded', () => {
  const s = new Store({ file: ':memory:', maxRows: 10 });
  for (let i = 0; i < 40; i++) s.recordEvent('agent1', 'poll', `n=${i}`);
  assert.ok(s.stats().events <= 10, `bounded at ${s.stats().events}`);
  s.close();
});

test('an unavailable driver degrades to no-ops rather than throwing', () => {
  // Monitoring that runs without history beats monitoring that will not run.
  const s = new Store({ file: ':memory:' });
  s.close();
  assert.doesNotThrow(() => {
    s.saveFinding(storeFinding());
    s.recordEvent('a', 'b');
    s.recentFindings();
    s.stats();
  });
});

/* --------------------------------- tracing ------------------------------- */

test('a correlation id is visible to everything inside the trace', async () => {
  assert.equal(currentCorrelationId(), undefined, 'no ambient id outside a trace');
  await withTrace('trace-1', 'agent1', async () => {
    assert.equal(currentCorrelationId(), 'trace-1');
    await new Promise((r) => setTimeout(r, 1));
    assert.equal(currentCorrelationId(), 'trace-1', 'survives an await');
  });
  assert.equal(currentCorrelationId(), undefined, 'does not leak out');
});

test('concurrent traces do not bleed into each other', async () => {
  const seen: string[] = [];
  await Promise.all([
    withTrace('a', 'x', async () => {
      await new Promise((r) => setTimeout(r, 5));
      seen.push(currentCorrelationId()!);
    }),
    withTrace('b', 'x', async () => {
      await new Promise((r) => setTimeout(r, 1));
      seen.push(currentCorrelationId()!);
    }),
  ]);
  assert.deepEqual(seen.sort(), ['a', 'b']);
});

test('outbound headers carry the id, and are empty outside a trace', () => {
  assert.deepEqual(traceHeaders(), {});
  withTrace('trace-9', 'agent6', () => {
    assert.deepEqual(traceHeaders(), { 'x-correlation-id': 'trace-9' });
  });
});

test('an axios interceptor adds the header without the call site knowing', () => {
  let installed: ((c: Record<string, unknown>) => Record<string, unknown>) | null = null;
  instrumentAxios({
    interceptors: {
      request: {
        use: (fn: (c: never) => never) => {
          installed = fn as never;
        },
      },
    },
  } as never);
  assert.ok(installed);
  withTrace('trace-x', 'agent7', () => {
    const out = installed!({ headers: { existing: '1' } });
    assert.equal((out.headers as Record<string, string>)['x-correlation-id'], 'trace-x');
    assert.equal((out.headers as Record<string, string>).existing, '1', 'existing headers survive');
  });
});

test('an HTTP request runs inside a trace matching its header', async () => {
  let observed: string | undefined;
  await withServer(
    { ...base },
    (s) =>
      s.app.get('/probe', (_q, r) => {
        observed = currentCorrelationId();
        r.json({ ok: true });
      }),
    async (url) => {
      await fetch(`${url}/probe`, { headers: { 'x-correlation-id': 'inbound-42' } });
      assert.equal(observed, 'inbound-42', 'the handler sees the inbound id');
    },
  );
});
