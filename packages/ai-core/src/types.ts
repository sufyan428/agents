import { z } from 'zod';

/**
 * Two adapters cover essentially the whole field.
 *
 * `openai-compatible` is the default and reaches OpenRouter, Gemini's
 * compatibility endpoint, Together, Groq, Ollama, vLLM, LM Studio, and
 * anything else that speaks `/chat/completions`. `anthropic` uses the official
 * SDK because Anthropic's native API is not OpenAI-shaped.
 */
export const PROVIDERS = ['openai-compatible', 'anthropic'] as const;
export const ProviderSchema = z.enum(PROVIDERS);
export type Provider = z.infer<typeof ProviderSchema>;

export const AiConfigSchema = z.object({
  provider: ProviderSchema.default('openai-compatible'),

  /**
   * Base URL for the OpenAI-compatible endpoint. Ignored by the anthropic
   * adapter, which the SDK points at Anthropic's API.
   */
  baseUrl: z.string().url().default('https://openrouter.ai/api/v1'),

  /**
   * Whatever the provider calls the model. Deliberately unconstrained — the
   * framework does not maintain a model allowlist, because it would be wrong
   * within a month.
   */
  model: z.string().min(1),

  apiKey: z.string().min(1),

  maxTokens: z.number().int().positive().default(2048),
  temperature: z.number().min(0).max(2).optional(),
  requestTimeoutMs: z.number().int().positive().default(45_000),

  /** Retries for transport failures and empty completions. */
  maxRetries: z.number().int().min(0).default(2),

  /** Consecutive failures before the breaker opens. */
  breakerThreshold: z.number().int().positive().default(5),
  /** How long the breaker stays open. */
  breakerCooldownMs: z.number().int().positive().default(120_000),

  /** Hard ceiling on calls per rolling 24h. Zero disables the AI layer. */
  dailyCallBudget: z.number().int().nonnegative().default(500),
  /** Hard ceiling on total tokens per rolling 24h. Zero means unlimited. */
  dailyTokenBudget: z.number().int().nonnegative().default(0),

  /** Sent as HTTP-Referer / X-Title on OpenRouter for attribution. */
  appName: z.string().default('router-agent-framework'),
  appUrl: z.string().default('https://github.com/sufiyansrepos/router-agent-framework'),
});

export type AiConfig = z.infer<typeof AiConfigSchema>;
export type AiConfigInput = z.input<typeof AiConfigSchema>;

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface CompletionResult {
  text: string;
  usage: Usage;
  model: string;
  /** Attempts consumed, including the successful one. */
  attempts: number;
}

/** Why a completion did not happen. Callers branch on this, not on strings. */
export type FailureReason =
  | 'auth' // bad or missing key - will not fix itself
  | 'forbidden' // key is valid but not entitled to this model or endpoint
  | 'rate_limit' // provider throttled us
  | 'timeout'
  | 'empty' // 200 with no content, endemic to free tiers
  | 'refused' // model declined the request
  | 'budget' // local budget exhausted
  | 'breaker_open' // too many recent failures
  | 'transport' // network or DNS
  | 'bad_response' // provider returned something unparseable
  | 'unknown';

export class AiError extends Error {
  constructor(
    readonly reason: FailureReason,
    message: string,
    readonly status?: number,
    readonly retryable: boolean = false,
  ) {
    super(message);
    this.name = 'AiError';
  }
}

export interface Adapter {
  readonly name: Provider;
  /** One request. Retries, budget and breaker live above this. */
  complete(system: string, user: string, signal: AbortSignal): Promise<CompletionResult>;
}

export interface Logger {
  debug(msg: string, meta?: unknown): void;
  info(msg: string, meta?: unknown): void;
  warn(msg: string, meta?: unknown): void;
  error(msg: string, meta?: unknown): void;
}

export const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};
