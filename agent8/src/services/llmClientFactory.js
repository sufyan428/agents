const AnthropicClient = require('./anthropicClient');
const OpenRouterClient = require('./openRouterClient');

function createLlmClient(config) {
  const { provider, apiKey, model, effort, max_tokens: maxTokens, request_timeout_ms: requestTimeoutMs } = config.ai;

  if (provider === 'anthropic') {
    return new AnthropicClient({ apiKey, model, effort, maxTokens, requestTimeoutMs });
  }

  if (provider === 'openrouter') {
    return new OpenRouterClient({ apiKey, model, maxTokens, requestTimeoutMs });
  }

  throw new Error(
    'No AI provider configured. Set ANTHROPIC_API_KEY (uses Claude) or OPENROUTER_API_KEY ' +
      '(uses OpenRouter, free by default) in .env before starting this agent.'
  );
}

module.exports = createLlmClient;
