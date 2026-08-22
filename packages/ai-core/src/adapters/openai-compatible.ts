import { AiError, type Adapter, type AiConfig, type CompletionResult } from '../types';

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string | null }; finish_reason?: string }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  model?: string;
  error?: { message?: string; code?: string | number };
}

/**
 * Speaks the OpenAI `/chat/completions` shape, which is the closest thing the
 * field has to a common denominator.
 *
 * Deliberately limited to `model`, `messages`, `max_tokens` and optionally
 * `temperature`. Nothing here assumes JSON mode, tool calling, structured
 * outputs, or system-prompt caching, because the free and self-hosted models
 * this framework targets frequently support none of them — and a provider that
 * rejects an unknown field fails the whole request rather than ignoring it.
 */
export class OpenAiCompatibleAdapter implements Adapter {
  readonly name = 'openai-compatible' as const;

  constructor(private readonly cfg: AiConfig) {}

  async complete(system: string, user: string, signal: AbortSignal): Promise<CompletionResult> {
    const url = `${this.cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`;

    const body: Record<string, unknown> = {
      model: this.cfg.model,
      max_tokens: this.cfg.maxTokens,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    };
    if (this.cfg.temperature !== undefined) body.temperature = this.cfg.temperature;

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.cfg.apiKey}`,
          'Content-Type': 'application/json',
          // OpenRouter attribution. Harmless everywhere else.
          'HTTP-Referer': this.cfg.appUrl,
          'X-Title': this.cfg.appName,
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        throw new AiError('timeout', `Request exceeded ${this.cfg.requestTimeoutMs}ms`, undefined, true);
      }
      throw new AiError('transport', `Could not reach ${url}: ${(err as Error).message}`, undefined, true);
    }

    if (!res.ok) throw await this.errorFor(res);

    let json: ChatCompletionResponse;
    try {
      json = (await res.json()) as ChatCompletionResponse;
    } catch {
      throw new AiError('bad_response', 'Provider returned a non-JSON body', res.status);
    }

    // Some gateways return HTTP 200 with an error object in the body.
    if (json.error) {
      throw new AiError('bad_response', `Provider error: ${json.error.message ?? 'unspecified'}`, 200);
    }

    const choice = json.choices?.[0];
    const text = choice?.message?.content ?? '';

    if (choice?.finish_reason === 'content_filter') {
      throw new AiError('refused', 'Model declined the request (content filter)', 200);
    }

    // A 200 with an empty completion is the signature failure of oversubscribed
    // free-tier models. It is retryable and usually clears on the next attempt.
    if (text.trim() === '') {
      throw new AiError('empty', 'Provider returned an empty completion', 200, true);
    }

    return {
      text,
      usage: {
        inputTokens: json.usage?.prompt_tokens ?? 0,
        outputTokens: json.usage?.completion_tokens ?? 0,
      },
      model: json.model ?? this.cfg.model,
      attempts: 1,
    };
  }

  private async errorFor(res: Response): Promise<AiError> {
    let detail = '';
    try {
      const body = (await res.json()) as ChatCompletionResponse;
      detail = body.error?.message ?? '';
    } catch {
      /* body was not JSON; the status alone will have to do */
    }

    // 401 means the key itself is bad, which will not fix itself and should
    // stop the AI layer. 403 usually means the key is fine but this account is
    // not entitled to this particular model - a config problem, not a
    // credential one, and it must not disable everything else.
    if (res.status === 401) {
      return new AiError('auth', `Authentication failed (401). Check the API key. ${detail}`.trim(), 401);
    }
    if (res.status === 403) {
      return new AiError(
        'forbidden',
        `Access denied (403) for model "${this.cfg.model}". The key is likely valid but not ` +
          `entitled to this model. ${detail}`.trim(),
        403,
      );
    }
    if (res.status === 429) {
      return new AiError('rate_limit', `Rate limited by provider. ${detail}`.trim(), 429, true);
    }
    if (res.status >= 500) {
      return new AiError('transport', `Provider server error ${res.status}. ${detail}`.trim(), res.status, true);
    }
    if (res.status === 404) {
      return new AiError(
        'bad_response',
        `Model "${this.cfg.model}" not found at ${this.cfg.baseUrl}. ${detail}`.trim(),
        404,
      );
    }
    return new AiError('unknown', `Provider returned ${res.status}. ${detail}`.trim(), res.status);
  }
}
