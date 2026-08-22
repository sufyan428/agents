/**
 * Configuration Loader Module
 *
 * Loads and validates the router configuration file
 */

const yaml = require('yaml');
const fs = require('fs');
const path = require('path');

class ConfigLoader {
  /**
   * Load configuration from YAML file
   * @param {string} configPath - Path to configuration file
   * @returns {Object} Parsed configuration object
   */
  static load(configPath) {
    try {
      const absolutePath = path.resolve(configPath);

      if (!fs.existsSync(absolutePath)) {
        throw new Error(`Configuration file not found: ${absolutePath}`);
      }

      const fileContent = fs.readFileSync(absolutePath, 'utf8');
      const config = yaml.parse(fileContent);

      // Validate required configuration sections
      ConfigLoader.validate(config);

      // Normalize configuration
      ConfigLoader.normalize(config);

      return config;
    } catch (error) {
      throw new Error(`Failed to load configuration: ${error.message}`);
    }
  }

  /**
   * Validate required configuration sections
   * @param {Object} config - Configuration object to validate
   */
  static validate(config) {
    const required = [
      'router',
      'syslog',
      'icmp',
      'security',
      'alerts',
      'logging',
      'prometheus',
      'agent',
    ];

    for (const section of required) {
      if (!config[section]) {
        throw new Error(`Missing required configuration section: ${section}`);
      }
    }

    // Validate router configuration
    if (!config.router.host) {
      throw new Error('Router host is required');
    }

    if (!config.router.snmp || !config.router.snmp.community) {
      throw new Error('SNMP community string is required');
    }

    // Validate security thresholds
    if (!config.security.authentication || !config.security.authentication.max_failed_attempts) {
      throw new Error('Authentication security thresholds are required');
    }
  }

  /**
   * Normalize configuration values
   * @param {Object} config - Configuration object to normalize
   */
  static normalize(config) {
    // Convert string booleans to actual booleans
    const booleanFields = [
      'syslog.enabled',
      'icmp.enabled',
      'security.configuration.enabled',
      'prometheus.enabled',
      'netconf.enabled',
      'restconf.enabled',
    ];

    booleanFields.forEach((field) => {
      const parts = field.split('.');
      let obj = config;
      for (let i = 0; i < parts.length - 1; i++) {
        obj = obj[parts[i]];
        if (!obj) return;
      }
      if (obj[parts[parts.length - 1]] === 'true') {
        obj[parts[parts.length - 1]] = true;
      } else if (obj[parts[parts.length - 1]] === 'false') {
        obj[parts[parts.length - 1]] = false;
      }
    });

    // Ensure numeric thresholds
    const numericFields = [
      'security.authentication.max_failed_attempts',
      'security.authentication.time_window_seconds',
      'security.traffic.baseline_samples',
      'security.traffic.anomaly_threshold',
      'security.configuration.validation_interval',
    ];

    numericFields.forEach((field) => {
      const parts = field.split('.');
      let obj = config;
      for (let i = 0; i < parts.length - 1; i++) {
        obj = obj[parts[i]];
        if (!obj) return;
      }
      if (typeof obj[parts[parts.length - 1]] === 'string') {
        obj[parts[parts.length - 1]] = parseFloat(obj[parts[parts.length - 1]]);
      }
    });
  }

  /**
   * Get golden baseline configuration
   * @param {string} basePath - Base path for resolving golden baseline file
   * @returns {Object} Golden baseline configuration
   */
  static loadGoldenBaseline(basePath) {
    const baselinePath = path.resolve(basePath, './config/golden-baseline.json');

    if (!fs.existsSync(baselinePath)) {
      throw new Error(`Golden baseline file not found: ${baselinePath}`);
    }

    try {
      const fileContent = fs.readFileSync(baselinePath, 'utf8');
      return JSON.parse(fileContent);
    } catch (error) {
      throw new Error(`Failed to load golden baseline: ${error.message}`);
    }
  }
}

module.exports = ConfigLoader;
