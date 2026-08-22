const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { resolveAiConfig } = require('@ragent/ai-core');

/**
 * Loads agent9's config and resolves its AI settings.
 *
 * The AI half is delegated to @ragent/ai-core so all four AI agents resolve
 * providers, models, keys and budgets identically. Previously each agent
 * carried its own copy of that logic, and they had already drifted.
 *
 * Returns config.ai as null when no key is configured. That is not an error:
 * the AI layer is optional by design, and the agent reports it clearly rather
 * than failing in a way that looks like a fault.
 */
class ConfigLoader {
  load(configPath = path.join(__dirname, '..', '..', 'config.yml'), env = process.env) {
    const config = yaml.load(fs.readFileSync(configPath, 'utf8'));

    if (env.PORT) config.server.port = parseInt(env.PORT, 10);
    if (env.BIND_HOST) config.server.host = env.BIND_HOST;

    const fileAi = config.ai || {};

    // Precedence is environment over config file. resolveAiConfig treats what
    // it is handed as an explicit override that beats the environment - correct
    // for programmatic use, wrong for a file value the operator expects to
    // override with an env var. So a file value is withheld when the matching
    // env var is set, letting the environment through.
    //
    // Without this, AI_DAILY_CALL_BUDGET=0 was silently ignored because
    // config.yml also specified a budget.
    const fromFile = (envKey, value) => {
      const fromEnv = env[envKey];
      return fromEnv !== undefined && fromEnv !== '' ? undefined : value;
    };

    config.ai = resolveAiConfig(
      {
        provider: fromFile('AI_PROVIDER', fileAi.provider),
        baseUrl: fromFile('AI_BASE_URL', fileAi.base_url),
        model: fromFile('AI_MODEL', fileAi.model),
        maxTokens: fromFile('AI_MAX_TOKENS', fileAi.max_tokens),
        requestTimeoutMs: fileAi.request_timeout_ms,
        dailyCallBudget: fromFile('AI_DAILY_CALL_BUDGET', fileAi.daily_call_budget),
        dailyTokenBudget: fromFile('AI_DAILY_TOKEN_BUDGET', fileAi.daily_token_budget),
        appName: 'agent9',
      },
      env,
    );

    return config;
  }
}

module.exports = new ConfigLoader();
