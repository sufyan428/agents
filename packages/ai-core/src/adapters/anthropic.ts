import { AiError, type Adapter, type AiConfig, type CompletionResult } from '../types';

/**
 * Native Anthropic adapter.
 *
 * The SDK is an optional dependency and is required lazily, so an install that
 * only ever points at an OpenAI-compatible endpoint never pays for it and never
 * fails if it is absent.
 *
 * Note on parameters: current Claude models reject `budget_tokens` and the
 * sampling parameters outright, and take reasoning depth through
 * `output_config.effort` with `thinking: { type: 'adaptive' }`. That is why
 * this adapter does not forward `temperature` even though the shared config
 * accepts it for the OpenAI-compatible path.
 */
export class AnthropicAdapter implements Adapter {
  readonly name = 'anthropic' as const;
  private client: unknown;

  constructor(private readonly cfg: AiConfig) {}

  private async getClient(): Promise<any> {
    if (this.client) return this.client;
    let Anthropic: any;
    try {
       
      Anthropic = require('@anthropic-ai/sdk');
    } catch {
      throw new AiError(
        'transport',
        'provider is "anthropic" but @anthropic-ai/sdk is not installed. ' +
          'Run `npm install @anthropic-ai/sdk`, or set provider to "openai-compatible".',
      );
    }
    const Ctor = Anthropic.default ?? Anthropic;
    this.client = new Ctor({ apiKey: this.cfg.apiKey });
    return this.client;
  }

  async complete(system: string, user: string, signal: AbortSignal): Promise<CompletionResult> {
    const client = await this.getClient();

    let response: any;
    try {
      response = await client.messages.create(
        {
          model: this.cfg.model,
          max_tokens: this.cfg.maxTokens,
          thinking: { type: 'adaptive' },
          system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
          messages: [{ role: 'user', content: user }],
        },
        { timeout: this.cfg.requestTimeoutMs, signal },
      );
    } catch (err) {
      throw this.translate(err as Error & { status?: number; name?: string });
    }

    if (response.stop_reason === 'refusal') {
      throw new AiError('refused', 'Model declined the request', 200);
    }

    const block = (response.content ?? []).find((b: { type: string }) => b.type === 'text');
    const text: string = block?.text ?? '';
    if (text.trim() === '') {
      throw new AiError('empty', 'Model returned no text content', 200, true);
    }

    return {
      text,
      usage: {
        inputTokens: response.usage?.input_tokens ?? 0,
        outputTokens: response.usage?.output_tokens ?? 0,
      },
      model: response.model ?? this.cfg.model,
      attempts: 1,
    };
  }

  private translate(err: Error & { status?: number; name?: string }): AiError {
    if (err.name === 'AbortError') {
      return new AiError('timeout', `Request exceeded ${this.cfg.requestTimeoutMs}ms`, undefined, true);
    }
    const status = err.status;
    if (status === 401) {
      return new AiError('auth', 'Authentication failed (401). Check the API key.', 401);
    }
    if (status === 403) {
      return new AiError('forbidden', `Access denied (403) for model "${this.cfg.model}".`, 403);
    }
    if (status === 429) {
      return new AiError('rate_limit', 'Rate limited by Anthropic', 429, true);
    }
    if (status !== undefined && status >= 500) {
      return new AiError('transport', `Anthropic server error ${status}`, status, true);
    }
    if (status === 404) {
      return new AiError('bad_response', `Model "${this.cfg.model}" not found`, 404);
    }
    return new AiError('unknown', err.message || 'Unknown Anthropic SDK error', status);
  }
}
