const Anthropic = require('@anthropic-ai/sdk');
const logger = require('../utils/logger');

class AnthropicClient {
  constructor({ apiKey, model, effort, maxTokens, requestTimeoutMs }) {
    if (!apiKey) {
      throw new Error('ANTHROPIC_API_KEY not set - cannot start the Anthropic client');
    }
    this.client = new Anthropic({ apiKey });
    this.model = model;
    this.effort = effort;
    this.maxTokens = maxTokens;
    this.requestTimeoutMs = requestTimeoutMs;
  }

  /**
   * Single-turn analysis call. systemPrompt is static across calls (the same
   * instructions every poll cycle) so it's marked cacheable; userContent is
   * the varying structured snapshot for this cycle.
   */
  async analyze(systemPrompt, userContent) {
    try {
      const response = await this.client.messages.create(
        {
          model: this.model,
          max_tokens: this.maxTokens,
          thinking: { type: 'adaptive' },
          output_config: { effort: this.effort },
          system: [
            {
              type: 'text',
              text: systemPrompt,
              cache_control: { type: 'ephemeral' }
            }
          ],
          messages: [{ role: 'user', content: userContent }]
        },
        { timeout: this.requestTimeoutMs }
      );

      if (response.stop_reason === 'refusal') {
        logger.warn('Claude declined the analysis request', {
          category: response.stop_details?.category || null
        });
        return null;
      }

      const textBlock = response.content.find((block) => block.type === 'text');
      return {
        text: textBlock ? textBlock.text : null,
        usage: response.usage,
        model: response.model
      };
    } catch (error) {
      if (error instanceof Anthropic.AuthenticationError) {
        logger.error(`Claude authentication failed - check ANTHROPIC_API_KEY: ${error.message}`);
      } else if (error instanceof Anthropic.RateLimitError) {
        logger.warn(`Claude rate limited (SDK already retries automatically): ${error.message}`);
      } else if (error instanceof Anthropic.APIConnectionError) {
        logger.warn(`Claude API connection failed: ${error.message}`);
      } else if (error instanceof Anthropic.APIError) {
        logger.error(`Claude API error (${error.status}): ${error.message}`);
      } else {
        logger.error(`Unexpected error calling Claude: ${error.message}`);
      }
      return null;
    }
  }
}

module.exports = AnthropicClient;
