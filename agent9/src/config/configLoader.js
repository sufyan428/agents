const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

class ConfigLoader {
  load(configPath = path.join(__dirname, '..', '..', 'config.yml')) {
    const fileContents = fs.readFileSync(configPath, 'utf8');
    const config = yaml.load(fileContents);

    if (process.env.PORT) {
      config.server.port = parseInt(process.env.PORT, 10);
    }
    if (process.env.ANTHROPIC_MODEL) {
      config.ai.anthropic.model = process.env.ANTHROPIC_MODEL;
    }
    if (process.env.OPENROUTER_MODEL) {
      config.ai.openrouter.model = process.env.OPENROUTER_MODEL;
    }

    const provider = this.resolveProvider(config.ai.provider);
    config.ai.provider = provider;

    if (provider === 'anthropic') {
      config.ai.apiKey = process.env.ANTHROPIC_API_KEY;
      config.ai.model = config.ai.anthropic.model;
      config.ai.effort = config.ai.anthropic.effort;
    } else if (provider === 'openrouter') {
      config.ai.apiKey = process.env.OPENROUTER_API_KEY;
      config.ai.model = config.ai.openrouter.model;
    } else {
      config.ai.apiKey = null;
      config.ai.model = null;
    }

    return config;
  }

  resolveProvider(configured) {
    if (configured === 'anthropic' || configured === 'openrouter') {
      return configured;
    }
    if (process.env.OPENROUTER_API_KEY) return 'openrouter';
    if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
    return null;
  }
}

module.exports = new ConfigLoader();
