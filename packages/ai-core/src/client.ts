import type { z } from 'zod';
import { OpenAiCompatibleAdapter } from './adapters/openai-compatible';
import { AnthropicAdapter } from './adapters/anthropic';
import { Budget, CircuitBreaker, type BudgetSnapshot } from './budget';
import { buildRepairPrompt, parseStructured } from './structured';
import {
  AiConfigSchema,
  AiError,
  noopLogger,
  type Adapter,
  type AiConfig,
  type AiConfigInput,
  type CompletionResult,
  type Logger,
} from './types';

export interface StructuredResult<T> {
  value: T;
  /** Which extraction strategy produced it: direct, fence, braces, or repaired. */
  strategy: string;
  /** Total provider attempts consumed, including any repair round-trip. */
  attempts: number;
}

export interface ClientStats {
  callsTotal: number;
  callsFailed: number;
  tokensIn: number;
  tokensOut: number;
  breaker: 'closed' | 'open' | 'permanently_open';
  budget: BudgetSnapshot;
  lastError: string | null;
  lastCallAt: string | null;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); }, { once: true });
  });
}

/**
 * The single entry point the AI agents use.
 *
 * Everything that makes an unattended LLM caller safe lives here rather than in
 * each agent: retries with jitter, a spend budget, a circuit breaker, and
 * schema-checked structured parsing with one repair attempt.
 *
 * Nothing in this class throws for an ordinary model failure. Callers get
 * `null` and fall back to their deterministic path — an AI layer that can take
 * down a monitoring agent by being unavailable would defeat the purpose of
 * making it optional.
 */
export class AiClient {
  private readonly adapter: Adapter;
  private readonly budget: Budget;
  private readonly breaker: CircuitBreaker;
  private readonly log: Logger;

  private callsTotal = 0;
  private callsFailed = 0;
  private tokensIn = 0;
  private tokensOut = 0;
  private lastError: string | null = null;
  private lastCallAt: string | null = null;

  constructor(readonly config: AiConfig, logger: Logger = noopLogger) {
    this.log = logger;
    this.adapter =
      config.provider === 'anthropic' ? new AnthropicAdapter(config) : new OpenAiCompatibleAdapter(config);
    this.budget = new Budget(config.dailyCallBudget, config.dailyTokenBudget);
    this.breaker = new CircuitBreaker(config.breakerThreshold, config.breakerCooldownMs);
  }

  /**
   * One completion, with retries. Returns null on any failure.
   *
   * Retries only what can plausibly succeed on a second try: timeouts,
   * transport errors, 429s, and the empty-completion case that oversubscribed
   * free endpoints produce. A bad key or an unknown model is returned
   * immediately — retrying those is pure waste.
   */
  async complete(system: string, user: string): Promise<CompletionResult | null> {
    if (this.breaker.isOpen) {
      this.log.warn(`AI call skipped: circuit breaker ${this.breaker.state}`);
      this.lastError = `breaker ${this.breaker.state}`;
      return null;
    }
    if (!this.budget.canSpend()) {
      const s = this.budget.snapshot();
      this.log.warn(
        `AI call skipped: daily budget exhausted (${s.callsUsed}/${s.callsLimit} calls). ` +
          `Window resets ${s.windowResetsAt ?? 'unknown'}`,
      );
      this.lastError = 'budget exhausted';
      return null;
    }

    const maxAttempts = this.config.maxRetries + 1;
    let lastErr: AiError | null = null;
    let attemptsMade = 0;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      attemptsMade = attempt;
      this.budget.recordCall();
      this.callsTotal++;
      this.lastCallAt = new Date().toISOString();

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);

      try {
        const result = await this.adapter.complete(system, user, controller.signal);
        clearTimeout(timer);

        this.tokensIn += result.usage.inputTokens;
        this.tokensOut += result.usage.outputTokens;
        this.budget.recordTokens(result.usage.inputTokens + result.usage.outputTokens);
        this.breaker.recordSuccess();
        this.lastError = null;

        return { ...result, attempts: attempt };
      } catch (err) {
        clearTimeout(timer);
        const aiErr = err instanceof AiError ? err : new AiError('unknown', (err as Error).message);
        lastErr = aiErr;
        this.callsFailed++;
        this.lastError = `${aiErr.reason}: ${aiErr.message}`;

        // An auth failure will not resolve itself. Stop, and stay stopped.
        if (aiErr.reason === 'auth') {
          this.breaker.recordFailure(true);
          this.log.error(`AI authentication failed - AI layer disabled until restart: ${aiErr.message}`);
          return null;
        }
        if (!aiErr.retryable || attempt === maxAttempts) break;

        // Exponential backoff with jitter, so several agents failing at once
        // do not retry in lockstep.
        const base = Math.min(1000 * 2 ** (attempt - 1), 8000);
        const wait = base + Math.floor(Math.random() * 250);
        this.log.warn(`AI call failed (${aiErr.reason}), retry ${attempt}/${this.config.maxRetries} in ${wait}ms`);
        try {
          await sleep(wait);
        } catch {
          break;
        }
      }
    }

    this.breaker.recordFailure();
    const gaveUp = lastErr?.retryable
      ? `after ${attemptsMade} attempt(s)`
      : `immediately (${lastErr?.reason ?? 'unknown'} is not retryable)`;
    this.log.warn(`AI call failed ${gaveUp}: ${lastErr?.message ?? 'unknown'}`);
    return null;
  }

  /**
   * A completion parsed into `schema`, with one repair round-trip if the first
   * response does not validate.
   *
   * Returns null rather than throwing, for the same reason `complete` does.
   */
  async completeStructured<T>(
    system: string,
    user: string,
    schema: z.ZodType<T>,
  ): Promise<StructuredResult<T> | null> {
    const first = await this.complete(system, user);
    if (!first) return null;

    const parsed = parseStructured(first.text, schema);
    if (parsed.ok) {
      return { value: parsed.value, strategy: parsed.strategy, attempts: first.attempts };
    }

    this.log.warn(`AI response failed schema validation (${parsed.error}) - attempting one repair`);

    const repaired = await this.complete(system, buildRepairPrompt(first.text, parsed.error));
    if (!repaired) return null;

    const second = parseStructured(repaired.text, schema);
    if (second.ok) {
      return { value: second.value, strategy: 'repaired', attempts: first.attempts + repaired.attempts };
    }

    this.log.warn(`AI response still invalid after repair (${second.error}) - caller should use its fallback`);
    return null;
  }

  /**
   * Cheap liveness and capability check.
   *
   * Worth running at startup so a wrong model name or a dead endpoint surfaces
   * immediately, with a clear message, rather than as a silent null on the
   * first real poll thirty minutes later.
   */
  async probe(): Promise<{ ok: boolean; detail: string }> {
    const result = await this.complete(
      'Reply with exactly the word: ok',
      'Reply with exactly the word: ok',
    );
    if (!result) return { ok: false, detail: this.lastError ?? 'no response' };
    return {
      ok: true,
      detail: `${this.config.provider} / ${result.model} responded in ${result.attempts} attempt(s)`,
    };
  }

  stats(): ClientStats {
    return {
      callsTotal: this.callsTotal,
      callsFailed: this.callsFailed,
      tokensIn: this.tokensIn,
      tokensOut: this.tokensOut,
      breaker: this.breaker.state,
      budget: this.budget.snapshot(),
      lastError: this.lastError,
      lastCallAt: this.lastCallAt,
    };
  }
}

/**
 * Resolves configuration from a partial config plus environment.
 *
 * Precedence is explicit config, then the generic `AI_*` variables, then the
 * legacy provider-specific ones that the agents already use today.
 *
 * `AI_*` is the shape the framework is moving to: the user names any model and
 * any endpoint, and the framework holds no opinion about which. The legacy
 * names keep working so nobody's existing `.env` breaks.
 */
export function resolveAiConfig(
  partial: Partial<AiConfigInput> = {},
  env: NodeJS.ProcessEnv = process.env,
): AiConfig | null {
  const explicitProvider = partial.provider ?? env.AI_PROVIDER;

  const anthropicKey = env.ANTHROPIC_API_KEY?.trim();
  const openrouterKey = env.OPENROUTER_API_KEY?.trim();
  const genericKey = env.AI_API_KEY?.trim();

  let provider = explicitProvider as AiConfig['provider'] | undefined;
  if (!provider) {
    // Prefer whichever key is actually present. OpenRouter wins a tie because
    // it is the documented default and the one with a free tier.
    if (genericKey || openrouterKey) provider = 'openai-compatible';
    else if (anthropicKey) provider = 'anthropic';
  }
  if (!provider) return null;

  const apiKey =
    partial.apiKey ??
    genericKey ??
    (provider === 'anthropic' ? anthropicKey : openrouterKey) ??
    undefined;
  if (!apiKey) return null;

  const model =
    partial.model ??
    env.AI_MODEL ??
    (provider === 'anthropic' ? env.ANTHROPIC_MODEL : env.OPENROUTER_MODEL) ??
    undefined;
  if (!model) return null;

  const numeric = (v: string | undefined): number | undefined => {
    if (v === undefined) return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };

  const candidate: AiConfigInput = {
    provider,
    model,
    apiKey,
    ...(partial.baseUrl !== undefined || env.AI_BASE_URL
      ? { baseUrl: partial.baseUrl ?? env.AI_BASE_URL }
      : {}),
    ...(partial.maxTokens !== undefined || numeric(env.AI_MAX_TOKENS) !== undefined
      ? { maxTokens: partial.maxTokens ?? numeric(env.AI_MAX_TOKENS) }
      : {}),
    ...(partial.dailyCallBudget !== undefined || numeric(env.AI_DAILY_CALL_BUDGET) !== undefined
      ? { dailyCallBudget: partial.dailyCallBudget ?? numeric(env.AI_DAILY_CALL_BUDGET) }
      : {}),
    ...(partial.dailyTokenBudget !== undefined || numeric(env.AI_DAILY_TOKEN_BUDGET) !== undefined
      ? { dailyTokenBudget: partial.dailyTokenBudget ?? numeric(env.AI_DAILY_TOKEN_BUDGET) }
      : {}),
    ...(partial.requestTimeoutMs !== undefined ? { requestTimeoutMs: partial.requestTimeoutMs } : {}),
    ...(partial.maxRetries !== undefined ? { maxRetries: partial.maxRetries } : {}),
    ...(partial.temperature !== undefined ? { temperature: partial.temperature } : {}),
    ...(partial.appName !== undefined ? { appName: partial.appName } : {}),
  };

  return AiConfigSchema.parse(candidate);
}

/** Convenience: resolve from env and construct, or null when no AI is configured. */
export function createAiClient(
  partial: Partial<AiConfigInput> = {},
  logger: Logger = noopLogger,
  env: NodeJS.ProcessEnv = process.env,
): AiClient | null {
  const cfg = resolveAiConfig(partial, env);
  if (!cfg) return null;
  return new AiClient(cfg, logger);
}
