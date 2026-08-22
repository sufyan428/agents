import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { parseStructured, buildRepairPrompt } from './structured';
import { Budget, CircuitBreaker } from './budget';
import { resolveAiConfig, AiClient } from './client';
import { AiError, type Adapter, type CompletionResult } from './types';
import { AiConfigSchema } from './types';

/* ------------------------------ structured ------------------------------ */

const Intent = z.object({ action: z.string(), agentName: z.string().nullable() });

test('parses clean JSON directly', () => {
  const r = parseStructured('{"action":"get_overview","agentName":null}', Intent);
  assert.ok(r.ok);
  assert.equal(r.strategy, 'direct');
  assert.equal(r.value.action, 'get_overview');
});

test('extracts JSON from a markdown fence', () => {
  const r = parseStructured(
    'Sure!\n```json\n{"action":"stop_agent","agentName":"agent1"}\n```\n',
    Intent,
  );
  assert.ok(r.ok);
  assert.equal(r.strategy, 'fence');
  assert.equal(r.value.agentName, 'agent1');
});

test('extracts JSON embedded in prose', () => {
  const r = parseStructured(
    'Here you go: {"action":"chat","agentName":null} - hope that helps!',
    Intent,
  );
  assert.ok(r.ok);
  assert.equal(r.strategy, 'braces');
});

test('brace extraction is not fooled by braces inside strings', () => {
  const S = z.object({ note: z.string() });
  const r = parseStructured('{"note":"a } brace and a { brace"}', S);
  assert.ok(r.ok);
  assert.equal(r.value.note, 'a } brace and a { brace');
});

test('repairs trailing commas, which small models emit constantly', () => {
  const r = parseStructured('{"action":"chat","agentName":null,}', Intent);
  assert.ok(r.ok);
  assert.equal(r.strategy, 'repaired');
});

test('valid JSON that violates the schema is a failure, not a pass', () => {
  const r = parseStructured('{"action":123,"agentName":null}', Intent);
  assert.ok(!r.ok);
  assert.match(r.error, /action/);
});

test('returns a failure - never throws - on garbage', () => {
  const r = parseStructured('I am afraid I cannot do that.', Intent);
  assert.ok(!r.ok);
  assert.ok(r.attempted >= 1);
});

test('repair prompt carries the error and truncates a huge original', () => {
  const p = buildRepairPrompt('x'.repeat(5000), 'action: expected string');
  assert.match(p, /action: expected string/);
  assert.match(p, /truncated/);
  assert.ok(p.length < 2500);
});

/* -------------------------------- budget -------------------------------- */

test('budget blocks once the call limit is reached', () => {
  const now = 1_000_000;
  const b = new Budget(3, 0, () => now);
  for (let i = 0; i < 3; i++) {
    assert.ok(b.canSpend());
    b.recordCall();
  }
  assert.ok(!b.canSpend());
});

test('budget window rolls forward after 24h', () => {
  let now = 1_000_000;
  const b = new Budget(2, 0, () => now);
  b.recordCall();
  b.recordCall();
  assert.ok(!b.canSpend());
  now += 24 * 60 * 60 * 1000 + 1;
  assert.ok(b.canSpend());
});

test('a zero call budget disables the AI layer entirely', () => {
  const b = new Budget(0, 0);
  assert.ok(!b.canSpend());
});

test('token budget blocks independently of call count', () => {
  const b = new Budget(100, 500);
  b.recordCall();
  b.recordTokens(600);
  assert.ok(!b.canSpend());
});

/* ------------------------------- breaker -------------------------------- */

test('breaker opens at the threshold and closes after cooldown', () => {
  let now = 0;
  const cb = new CircuitBreaker(3, 60_000, () => now);
  cb.recordFailure();
  cb.recordFailure();
  assert.ok(!cb.isOpen);
  cb.recordFailure();
  assert.ok(cb.isOpen);
  assert.equal(cb.state, 'open');
  now += 60_001;
  assert.ok(!cb.isOpen, 'should half-open after cooldown');
});

test('success resets the failure count', () => {
  const cb = new CircuitBreaker(2, 1000);
  cb.recordFailure();
  cb.recordSuccess();
  cb.recordFailure();
  assert.ok(!cb.isOpen);
});

test('an auth failure opens the breaker permanently', () => {
  let now = 0;
  const cb = new CircuitBreaker(5, 1000, () => now);
  cb.recordFailure(true);
  assert.equal(cb.state, 'permanently_open');
  now += 10_000_000;
  assert.ok(cb.isOpen, 'a bad key does not fix itself by waiting');
});

/* ---------------------------- config resolution -------------------------- */

test('AI_* generic vars are preferred and need no provider named', () => {
  const cfg = resolveAiConfig({}, {
    AI_API_KEY: 'k',
    AI_MODEL: 'meta-llama/llama-3.3-70b-instruct:free',
    AI_BASE_URL: 'https://openrouter.ai/api/v1',
  } as NodeJS.ProcessEnv);
  assert.ok(cfg);
  assert.equal(cfg.provider, 'openai-compatible');
  assert.equal(cfg.model, 'meta-llama/llama-3.3-70b-instruct:free');
});

test('legacy OPENROUTER_* still resolves, so existing .env files keep working', () => {
  const cfg = resolveAiConfig({}, {
    OPENROUTER_API_KEY: 'k',
    OPENROUTER_MODEL: 'openai/gpt-oss-20b:free',
  } as NodeJS.ProcessEnv);
  assert.ok(cfg);
  assert.equal(cfg.provider, 'openai-compatible');
  assert.equal(cfg.baseUrl, 'https://openrouter.ai/api/v1');
});

test('an Anthropic key alone selects the anthropic adapter', () => {
  const cfg = resolveAiConfig({}, {
    ANTHROPIC_API_KEY: 'k',
    ANTHROPIC_MODEL: 'claude-opus-5',
  } as NodeJS.ProcessEnv);
  assert.ok(cfg);
  assert.equal(cfg.provider, 'anthropic');
});

test('no key means no AI - null, not a throw', () => {
  assert.equal(resolveAiConfig({}, {} as NodeJS.ProcessEnv), null);
});

test('a key with no model is not enough', () => {
  assert.equal(resolveAiConfig({}, { AI_API_KEY: 'k' } as NodeJS.ProcessEnv), null);
});

test('explicit config beats the environment', () => {
  const cfg = resolveAiConfig({ model: 'explicit-model' }, {
    AI_API_KEY: 'k',
    AI_MODEL: 'env-model',
  } as NodeJS.ProcessEnv);
  assert.equal(cfg?.model, 'explicit-model');
});

/* ------------------------------ client flow ------------------------------ */

function cfg(over: Record<string, unknown> = {}) {
  return AiConfigSchema.parse({ model: 'm', apiKey: 'k', maxRetries: 1, ...over });
}

class ScriptedAdapter implements Adapter {
  readonly name = 'openai-compatible' as const;
  calls = 0;
  constructor(private readonly script: Array<CompletionResult | AiError>) {}
  async complete(): Promise<CompletionResult> {
    const step = this.script[Math.min(this.calls, this.script.length - 1)];
    this.calls++;
    if (step instanceof AiError) throw step;
    return step as CompletionResult;
  }
}

function withAdapter(client: AiClient, adapter: Adapter): AiClient {
  (client as unknown as { adapter: Adapter }).adapter = adapter;
  return client;
}

const okResult = (text: string): CompletionResult => ({
  text,
  usage: { inputTokens: 10, outputTokens: 5 },
  model: 'm',
  attempts: 1,
});

test('retries an empty completion and succeeds - the free-tier failure mode', async () => {
  const adapter = new ScriptedAdapter([
    new AiError('empty', 'empty', 200, true),
    okResult('recovered'),
  ]);
  const c = withAdapter(new AiClient(cfg({ maxRetries: 2 })), adapter);
  const r = await c.complete('sys', 'user');
  assert.ok(r);
  assert.equal(r.text, 'recovered');
  assert.equal(adapter.calls, 2);
});

test('does not retry a non-retryable error', async () => {
  const adapter = new ScriptedAdapter([new AiError('bad_response', 'model not found', 404, false)]);
  const c = withAdapter(new AiClient(cfg({ maxRetries: 3 })), adapter);
  assert.equal(await c.complete('s', 'u'), null);
  assert.equal(adapter.calls, 1, 'a 404 must not be retried');
});

test('an auth failure returns null and disables further calls', async () => {
  const adapter = new ScriptedAdapter([new AiError('auth', '401', 401, false)]);
  const c = withAdapter(new AiClient(cfg()), adapter);
  assert.equal(await c.complete('s', 'u'), null);
  const before = adapter.calls;
  assert.equal(await c.complete('s', 'u'), null);
  assert.equal(adapter.calls, before, 'breaker must block the second call outright');
  assert.equal(c.stats().breaker, 'permanently_open');
});

test('an exhausted budget short-circuits before hitting the adapter', async () => {
  const adapter = new ScriptedAdapter([okResult('hi')]);
  const c = withAdapter(new AiClient(cfg({ dailyCallBudget: 0 })), adapter);
  assert.equal(await c.complete('s', 'u'), null);
  assert.equal(adapter.calls, 0);
});

test('failed attempts still consume budget - failures are not free', async () => {
  const adapter = new ScriptedAdapter([new AiError('empty', 'e', 200, true)]);
  const c = withAdapter(new AiClient(cfg({ maxRetries: 1, dailyCallBudget: 10 })), adapter);
  await c.complete('s', 'u');
  assert.equal(c.stats().budget.callsUsed, 2);
});

test('completeStructured repairs an unparseable first response', async () => {
  const adapter = new ScriptedAdapter([
    okResult('I think the answer is get_overview'),
    okResult('{"action":"get_overview","agentName":null}'),
  ]);
  const c = withAdapter(new AiClient(cfg()), adapter);
  const r = await c.completeStructured('s', 'u', Intent);
  assert.ok(r);
  assert.equal(r.strategy, 'repaired');
  assert.equal(r.value.action, 'get_overview');
});

test('completeStructured gives up after one repair rather than looping', async () => {
  const adapter = new ScriptedAdapter([okResult('still not json')]);
  const c = withAdapter(new AiClient(cfg({ maxRetries: 0 })), adapter);
  assert.equal(await c.completeStructured('s', 'u', Intent), null);
  assert.equal(adapter.calls, 2, 'one original plus exactly one repair');
});

test('stats track tokens and failures', async () => {
  const adapter = new ScriptedAdapter([okResult('ok')]);
  const c = withAdapter(new AiClient(cfg()), adapter);
  await c.complete('s', 'u');
  const s = c.stats();
  assert.equal(s.callsTotal, 1);
  assert.equal(s.callsFailed, 0);
  assert.equal(s.tokensIn, 10);
  assert.equal(s.tokensOut, 5);
  assert.equal(s.lastError, null);
});

test('a 403 does NOT permanently disable the client - only a 401 does', async () => {
  // Regression: an inaccessible model returned 403, was classified as an auth
  // failure, and permanently opened the breaker - taking down the whole AI
  // layer because of one bad model name in the config.
  const adapter = new ScriptedAdapter([new AiError('forbidden', 'no access to model', 403, false)]);
  const c = withAdapter(new AiClient(cfg()), adapter);
  assert.equal(await c.complete('s', 'u'), null);
  assert.notEqual(c.stats().breaker, 'permanently_open');

  const authAdapter = new ScriptedAdapter([new AiError('auth', 'bad key', 401, false)]);
  const c2 = withAdapter(new AiClient(cfg()), authAdapter);
  await c2.complete('s', 'u');
  assert.equal(c2.stats().breaker, 'permanently_open');
});
