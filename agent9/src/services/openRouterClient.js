const axios = require('axios');
const logger = require('../utils/logger');

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

class OpenRouterClient {
  constructor({ apiKey, model, maxTokens, requestTimeoutMs }) {
    if (!apiKey) {
      throw new Error('OPENROUTER_API_KEY not set - cannot start the OpenRouter client');
    }
    this.apiKey = apiKey;
    this.model = model;
    this.maxTokens = maxTokens;
    this.requestTimeoutMs = requestTimeoutMs;
  }

  /**
   * Single-turn analysis call over OpenRouter's OpenAI-compatible chat
   * completions endpoint. Kept to the minimal, universally-supported params
   * (model/messages/max_tokens) since the user can swap `model` to any
   * OpenRouter-hosted model by name - provider-specific extras (reasoning
   * effort, etc.) aren't guaranteed to exist on whatever they pick.
   *
   * Free-tier models occasionally return a 200 with an empty completion
   * under shared load (no error to catch, just nothing in the message) - one
   * retry clears this up in practice, so it's handled here rather than
   * surfacing a spurious failure to the caller.
   */
  async analyze(systemPrompt, userContent, attempt = 1) {
    try {
      const response = await axios.post(
        OPENROUTER_URL,
        {
          model: this.model,
          max_tokens: this.maxTokens,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userContent }
          ]
        },
        {
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://github.com/router-agent-framework',
            'X-Title': 'AI Correlation Agent'
          },
          timeout: this.requestTimeoutMs
        }
      );

      const choice = response.data.choices?.[0];
      const text = choice?.message?.content || null;

      if (!text && attempt < 2) {
        logger.warn('OpenRouter returned an empty completion (known free-tier flakiness), retrying once');
        return this.analyze(systemPrompt, userContent, attempt + 1);
      }

      return {
        text,
        usage: response.data.usage,
        model: response.data.model || this.model
      };
    } catch (error) {
      if (error.response) {
        const status = error.response.status;
        const message = error.response.data?.error?.message || error.message;
        if (status === 401) {
          logger.error(`OpenRouter authentication failed - check OPENROUTER_API_KEY: ${message}`);
        } else if (status === 429) {
          logger.warn(`OpenRouter rate limited (free-tier models have low daily/RPM caps): ${message}`);
        } else {
          logger.error(`OpenRouter API error (${status}): ${message}`);
        }
      } else {
        logger.error(`Unexpected error calling OpenRouter: ${error.message}`);
      }
      return null;
    }
  }
}

module.exports = OpenRouterClient;
