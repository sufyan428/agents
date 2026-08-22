/**
 * Configuration loader utility
 * Loads and validates YAML configuration files
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const logger = require('./logger');

class ConfigLoader {
  constructor() {
    this.config = {};
    this.thresholds = {};
  }

  /**
   * Load configuration files
   */
  load() {
    try {
      const routerConfigPath = path.join(__dirname, '../../config/router.yml');
      const thresholdsConfigPath = path.join(__dirname, '../../config/thresholds.yml');

      this.config = this.loadYamlFile(routerConfigPath);
      // Mutate in place (not reassign) — thresholdProcessor captures this.thresholds
      // by reference at construction time, before load() has run.
      Object.assign(this.thresholds, this.loadYamlFile(thresholdsConfigPath));

      logger.info('Configuration loaded successfully');
      logger.info(`Monitoring ${this.config.routers.filter(r => r.enabled).length} routers`);

      return {
        router: this.config,
        thresholds: this.thresholds
      };
    } catch (error) {
      logger.error(`Failed to load configuration: ${error.message}`);
      throw error;
    }
  }

  /**
   * Load and parse YAML file
   */
  loadYamlFile(filePath) {
    try {
      const fileContents = fs.readFileSync(filePath, 'utf8');
      return yaml.load(fileContents);
    } catch (error) {
      logger.error(`Failed to load YAML file ${filePath}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get enabled routers
   */
  getEnabledRouters() {
    return this.config.routers.filter(router => router.enabled);
  }

  /**
   * Get all routers
   */
  getAllRouters() {
    return this.config.routers || [];
  }

  /**
   * Get thresholds for a specific metric
   */
  getThreshold(metric) {
    return this.thresholds[metric] || null;
  }

  /**
   * Get router configuration by name
   */
  getRouter(name) {
    return this.config.routers.find(router => router.name === name);
  }

  /**
   * Get default OIDs
   */
  getDefaultOids() {
    return this.config.default_oids || {};
  }

  /**
   * Get Syslog configuration
   */
  getSyslogConfig() {
    return this.config.syslog || { enabled: false };
  }
}

module.exports = new ConfigLoader();