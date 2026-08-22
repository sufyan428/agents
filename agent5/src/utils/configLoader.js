const fs = require('fs').promises;
const path = require('path');
const yaml = require('yaml');
const logger = require('./logger');

class ConfigLoader {
  constructor() {
    this.config = null;
    this.routerConfig = null;
  }

  async loadConfig(configPath = './config.yml') {
    try {
      const configContent = await fs.readFile(configPath, 'utf8');
      this.config = yaml.parse(configContent);
      logger.info(`Configuration loaded from ${configPath}`);
      return this.config;
    } catch (error) {
      logger.error(`Failed to load configuration: ${error.message}`);
      throw error;
    }
  }

  async loadRouterConfig(routerConfigPath = './router.yml') {
    try {
      const routerConfigContent = await fs.readFile(routerConfigPath, 'utf8');
      this.routerConfig = yaml.parse(routerConfigContent);
      logger.info(`Router configuration loaded from ${routerConfigPath}`);
      return this.routerConfig;
    } catch (error) {
      logger.error(`Failed to load router configuration: ${error.message}`);
      throw error;
    }
  }

  async loadAllConfigs(configPath = './config.yml', routerConfigPath = './router.yml') {
    await Promise.all([
      this.loadConfig(configPath),
      this.loadRouterConfig(routerConfigPath)
    ]);
    return {
      config: this.config,
      routerConfig: this.routerConfig
    };
  }

  getConfig() {
    return this.config;
  }

  getRouterConfig() {
    return this.routerConfig;
  }

  getRouters() {
    return this.routerConfig?.routers || [];
  }

  getServerConfig() {
    return this.config?.server || { port: 9091 };
  }

  getGovernanceConfig() {
    return this.config?.governance || {};
  }

  getSchedulingConfig() {
    return this.config?.scheduling || {};
  }

  getLoggingConfig() {
    return this.config?.logging || { level: 'info', directory: './logs' };
  }

  validateConfig() {
    const errors = [];

    if (!this.config) {
      errors.push('Main configuration not loaded');
      return { valid: false, errors };
    }

    if (!this.routerConfig) {
      errors.push('Router configuration not loaded');
    } else if (!this.routerConfig.routers || this.routerConfig.routers.length === 0) {
      errors.push('No routers configured');
    }

    if (!this.config.server || !this.config.server.port) {
      errors.push('Server port not configured');
    }

    if (errors.length > 0) {
      logger.error(`Configuration validation failed: ${errors.join(', ')}`);
      return { valid: false, errors };
    }

    logger.info('Configuration validation passed');
    return { valid: true, errors: [] };
  }
}

module.exports = ConfigLoader;