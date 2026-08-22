const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const DEFAULT_CONFIG_PATH =
  process.env.CONFIG_PATH ||
  (fs.existsSync('/app/config/router.yml')
    ? '/app/config/router.yml'
    : path.join(__dirname, '..', '..', 'config', 'router.yml'));

class ConfigLoader {
  constructor(configPath = DEFAULT_CONFIG_PATH) {
    this.configPath = configPath;
    this.config = null;
  }

  load() {
    try {
      const configFile = fs.readFileSync(this.configPath, 'utf8');
      this.config = yaml.load(configFile);
      this.validate();
      this.applyEnvironmentOverrides();
      return this.config;
    } catch (error) {
      throw new Error(`Failed to load configuration: ${error.message}`);
    }
  }

  validate() {
    if (!this.config.primary || !this.config.primary.host) {
      throw new Error('Primary router configuration is missing');
    }

    if (!this.config.backup || !this.config.backup.host) {
      throw new Error('Backup router configuration is missing');
    }

    if (!this.config.failover) {
      throw new Error('Failover configuration is missing');
    }

    return true;
  }

  applyEnvironmentOverrides() {
    // Override config values with environment variables if present
    const overrides = {
      PRIMARY_HOST: 'primary.host',
      PRIMARY_COMMUNITY: 'primary.community',
      BACKUP_HOST: 'backup.host',
      BACKUP_COMMUNITY: 'backup.community',
      LOG_LEVEL: 'logging.level',
      METRICS_PORT: 'metrics.port',
    };

    for (const [envVar, configPath] of Object.entries(overrides)) {
      if (process.env[envVar]) {
        const keys = configPath.split('.');
        let target = this.config;
        for (let i = 0; i < keys.length - 1; i++) {
          if (!target[keys[i]]) {
            target[keys[i]] = {};
          }
          target = target[keys[i]];
        }
        target[keys[keys.length - 1]] = process.env[envVar];
      }
    }
  }

  get(key) {
    if (!this.config) {
      this.load();
    }
    return this.getNestedValue(this.config, key);
  }

  getNestedValue(obj, key) {
    const keys = key.split('.');
    let result = obj;
    for (const k of keys) {
      result = result?.[k];
    }
    return result;
  }

  reload() {
    return this.load();
  }
}

module.exports = ConfigLoader;
