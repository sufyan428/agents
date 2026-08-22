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
    PORT: '9090', DEBUG: 'true', RATIO: '0.25',
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
    (s) => s.app.get('/data', (_q, r) => { r.json({ ok: true }); }),
    async (url) => {
      const res = await fetch(`${url}/data`);
      assert.equal(res.status, 200);
    },
  );
});

test('a mutating request without a token is 401', async () => {
  await withServer(
    { ...base, authToken: 'secret' },
    (s) => s.app.post('/stop', (_q, r) => { r.json({ stopped: true }); }),
    async (url) => {
      const res = await fetch(`${url}/stop`, { method: 'POST' });
      assert.equal(res.status, 401);
    },
  );
});

test('a mutating request with a wrong token is 401', async () => {
  await withServer(
    { ...base, authToken: 'secret' },
    (s) => s.app.post('/stop', (_q, r) => { r.json({ stopped: true }); }),
    async (url) => {
      const res = await fetch(`${url}/stop`, {
        method: 'POST', headers: { authorization: 'Bearer wrong' },
      });
      assert.equal(res.status, 401);
    },
  );
});

test('a mutating request with the right token succeeds', async () => {
  await withServer(
    { ...base, authToken: 'secret' },
    (s) => s.app.post('/stop', (_q, r) => { r.json({ stopped: true }); }),
    async (url) => {
      const res = await fetch(`${url}/stop`, {
        method: 'POST', headers: { authorization: 'Bearer secret' },
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
    (s) => s.app.post('/failover', (_q, r) => { r.json({ triggered: true }); }),
    async (url) => {
      const res = await fetch(`${url}/failover`, { method: 'POST' });
      assert.equal(res.status, 503);
      const body = await res.json() as { error: string };
      assert.match(body.error, /AGENT_API_TOKEN/);
    },
  );
});

test('publicPaths bypass auth for mutating methods', async () => {
  await withServer(
    { ...base, authToken: 'secret', publicPaths: ['/webhook'] },
    (s) => s.app.post('/webhook', (_q, r) => { r.json({ ok: true }); }),
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
      const body = await res.json() as { status: string };
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
  await withServer({ ...base }, () => {}, async (url) => {
    const res = await fetch(`${url}/metrics`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/plain/);
    assert.match(await res.text(), /process_cpu_user_seconds_total|nodejs_/);
  });
});

test('an unknown path is a JSON 404, not an HTML stack page', async () => {
  await withServer({ ...base }, () => {}, async (url) => {
    const res = await fetch(`${url}/nope`);
    assert.equal(res.status, 404);
    const body = await res.json() as { error: string };
    assert.equal(body.error, 'Not found');
  });
});

test('a thrown error returns an opaque 500 with a correlation id, never internals', async () => {
  await withServer(
    { ...base },
    (s) => s.app.get('/boom', () => { throw new Error('secret internal detail at /srv/app/x.js'); }),
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
  await withServer({ ...base }, () => {}, async (url) => {
    const res = await fetch(`${url}/health`, { headers: { 'x-correlation-id': 'trace-123' } });
    assert.equal(res.headers.get('x-correlation-id'), 'trace-123');
  });
});

test('a malformed inbound correlation id is replaced, not trusted', async () => {
  await withServer({ ...base }, () => {}, async (url) => {
    const res = await fetch(`${url}/health`, { headers: { 'x-correlation-id': 'bad id with spaces!' } });
    const cid = res.headers.get('x-correlation-id') ?? '';
    assert.notEqual(cid, 'bad id with spaces!');
    assert.match(cid, /^c-/);
  });
});

test('cross-origin is denied by default', async () => {
  await withServer({ ...base }, () => {}, async (url) => {
    const res = await fetch(`${url}/health`, { headers: { origin: 'https://evil.example' } });
    assert.equal(res.headers.get('access-control-allow-origin'), null);
  });
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
  await withServer({ ...base }, () => {}, async (url) => {
    const res = await fetch(`${url}/health`);
    assert.equal(res.headers.get('x-powered-by'), null);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  });
});

test('an oversized body is rejected', async () => {
  await withServer(
    { ...base, authToken: 't', bodyLimit: '1kb' },
    (s) => s.app.post('/ingest', (_q, r) => { r.json({ ok: true }); }),
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
