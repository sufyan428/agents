/**
 * Configuration Validation Module
 * 
 * Validates router configurations against a golden baseline to detect:
 * - Configuration drift
 * - Unauthorized changes
 * - Security policy violations
 * - Critical configuration modifications
 */

const ConfigLoader = require('../config/config-loader');
const axios = require('axios');
// axios-retry v4 exposes the callable on .default; v3 exported it directly.
const axiosRetry = require('axios-retry').default || require('axios-retry');

// Configure axios retry for better reliability
axiosRetry(axios, {
  retries: 3,
  retryDelay: axiosRetry.exponentialDelay,
  retryCondition: (error) => {
    return axiosRetry.isNetworkOrIdempotentRequestError(error) || 
           error.code === 'ECONNABORTED' ||
           error.code === 'ETIMEDOUT';
  }
});

class ConfigurationValidator {
  constructor(config, routerConfig, logger, metrics, alertDispatcher) {
    this.config = config;
    this.routerConfig = routerConfig;
    this.logger = logger;
    this.metrics = metrics;
    this.alertDispatcher = alertDispatcher;

    this.goldenBaseline = null;
    this.currentConfig = null;
    this.validationInterval = null;
    this.isRunning = false;
  }

  /**
   * Start configuration validation
   */
  async start() {
    try {
      this.logger.info('Starting configuration validator');

      // Load golden baseline
      await this.loadGoldenBaseline();

      // Start periodic validation
      this.validationInterval = setInterval(async () => {
        await this.validateConfiguration();
      }, this.config.validation_interval * 1000);

      this.isRunning = true;
      this.logger.info('Configuration validator started', {
        validation_interval: this.config.validation_interval
      });

    } catch (error) {
      this.logger.error('Failed to start configuration validator:', error);
      throw error;
    }
  }

  /**
   * Stop configuration validation
   */
  async stop() {
    if (this.validationInterval) {
      clearInterval(this.validationInterval);
      this.validationInterval = null;
    }

    this.isRunning = false;
    this.logger.info('Configuration validator stopped');
  }

  /**
   * Check if validator is running
   */
  isRunning() {
    return this.isRunning;
  }

  /**
   * Load golden baseline configuration
   */
  async loadGoldenBaseline() {
    try {
      this.logger.info('Loading golden baseline configuration');

      this.goldenBaseline = ConfigLoader.loadGoldenBaseline(process.cwd());

      this.logger.info('Golden baseline loaded successfully', {
        version: this.goldenBaseline.metadata?.version,
        created: this.goldenBaseline.metadata?.created
      });

    } catch (error) {
      this.logger.error('Failed to load golden baseline:', error);
      throw new Error(`Golden baseline load failed: ${error.message}`);
    }
  }

  /**
   * Validate current router configuration against golden baseline
   */
  async validateConfiguration() {
    const startTime = Date.now();

    try {
      this.logger.debug('Starting configuration validation');

      // Fetch current router configuration
      this.currentConfig = await this.fetchCurrentConfiguration();

      if (!this.currentConfig) {
        this.logger.warn('Failed to fetch current configuration');
        this.metrics.recordConfigurationValidation('failed');
        return;
      }

      // Compare configurations
      const differences = this.compareConfigurations();

      // Calculate drift score
      const driftScore = this.calculateDriftScore(differences);
      this.metrics.updateConfigurationDrift(this.routerConfig.host, driftScore);

      // Analyze differences and generate alerts
      await this.analyzeDifferences(differences);

      // Record successful validation
      this.metrics.recordConfigurationValidation('success');

      const duration = (Date.now() - startTime) / 1000;
      this.metrics.recordCheckDuration('configuration_validation', duration);

      this.logger.debug('Configuration validation completed', {
        drift_score: driftScore,
        differences_count: differences.length,
        duration: duration.toFixed(2)
      });

    } catch (error) {
      this.logger.error('Error validating configuration:', error);
      this.metrics.recordConfigurationValidation('error');
    }
  }

  /**
   * Fetch current router configuration
   */
  async fetchCurrentConfiguration() {
    try {
      // Try NETCONF first if enabled
      if (this.routerConfig.netconf?.enabled) {
        return await this.fetchViaNetconf();
      }

      // Try RESTCONF if enabled
      if (this.routerConfig.restconf?.enabled) {
        return await this.fetchViaRestconf();
      }

      // Fallback to SNMP for basic configuration
      return await this.fetchViaSnmp();

    } catch (error) {
      this.logger.error('Failed to fetch router configuration:', error);
      return null;
    }
  }

  /**
   * Fetch configuration via NETCONF
   */
  async fetchViaNetconf() {
    // NETCONF implementation would go here
    // This is a placeholder for demonstration
    this.logger.info('Fetching configuration via NETCONF (not implemented in demo)');
    return this.generateSimulatedConfig();
  }

  /**
   * Fetch configuration via RESTCONF
   */
  async fetchViaRestconf() {
    try {
      const url = `https://${this.routerConfig.host}:${this.routerConfig.restconf.port}${this.routerConfig.restconf.base_path}/data/Cisco-IOS-XE-native:native`;
      
      const response = await axios.get(url, {
        auth: {
          username: this.routerConfig.restconf.username,
          password: this.routerConfig.restconf.password
        },
        timeout: 10000,
        httpsAgent: new (require('https').Agent)({
          // Certificate verification on by default; this request carries
          // RESTCONF credentials. ROUTER_TLS_INSECURE=true opts out for a lab
          // device with a self-signed cert, deliberately and visibly.
          rejectUnauthorized: process.env.ROUTER_TLS_INSECURE !== 'true'
        })
      });

      this.logger.debug('Configuration fetched via RESTCONF');
      return this.normalizeConfig(response.data);

    } catch (error) {
      this.logger.warn('RESTCONF fetch failed:', error.message);
      throw error;
    }
  }

  /**
   * Fetch configuration via SNMP (basic version)
   */
  async fetchViaSnmp() {
    this.logger.info('Fetching basic configuration via SNMP (simulated for demo)');
    return this.generateSimulatedConfig();
  }

  /**
   * Generate simulated configuration for demo purposes
   */
  generateSimulatedConfig() {
    // In production, this would be replaced with actual router configuration
    return {
      system: {
        hostname: "secure-router-01",
        timezone: "UTC"
      },
      interfaces: {
        management: {
          enabled: true,
          ssh_enabled: true,
          telnet_enabled: false
        }
      },
      security: {
        authentication: {
          max_failed_attempts: 5
        }
      },
      firewall: {
        default_policy: "deny",
        rules: [
          {
            id: 1,
            action: "allow",
            protocol: "tcp",
            port: "22"
          }
        ]
      },
      services: {
        disabled_services: ["telnet", "http"],
        enabled_services: ["ssh", "https"]
      }
    };
  }

  /**
   * Normalize configuration to consistent format
   */
  normalizeConfig(config) {
    // Ensure consistent structure
    return {
      system: config.system || {},
      interfaces: config.interfaces || {},
      security: config.security || {},
      firewall: config.firewall || {},
      services: config.services || {}
    };
  }

  /**
   * Compare current configuration with golden baseline
   */
  compareConfigurations() {
    const differences = [];

    try {
      const golden = this.goldenBaseline.router_configuration;
      const current = this.currentConfig;

      // Compare system configuration
      this.compareSection('system', golden.system, current.system, differences);

      // Compare interfaces
      this.compareSection('interfaces', golden.interfaces, current.interfaces, differences);

      // Compare security settings
      this.compareSection('security', golden.security, current.security, differences);

      // Compare firewall rules
      this.compareSection('firewall', golden.firewall, current.firewall, differences);

      // Compare services
      this.compareSection('services', golden.services, current.services, differences);

    } catch (error) {
      this.logger.error('Error comparing configurations:', error);
    }

    return differences;
  }

  /**
   * Compare a configuration section
   */
  compareSection(sectionName, goldenSection, currentSection, differences) {
    if (!goldenSection || !currentSection) {
      return;
    }

    // Check for missing keys in current config
    for (const key of Object.keys(goldenSection)) {
      if (!(key in currentSection)) {
        differences.push({
          section: sectionName,
          type: 'missing',
          field: key,
          golden_value: goldenSection[key],
          current_value: null,
          severity: this.getSeverity(sectionName, key, 'missing')
        });
      }
    }

    // Check for unexpected keys in current config
    for (const key of Object.keys(currentSection)) {
      if (!(key in goldenSection)) {
        differences.push({
          section: sectionName,
          type: 'unexpected',
          field: key,
          golden_value: null,
          current_value: currentSection[key],
          severity: this.getSeverity(sectionName, key, 'unexpected')
        });
      }
    }

    // Check for value differences
    for (const key of Object.keys(goldenSection)) {
      if (key in currentSection) {
        const goldenValue = JSON.stringify(goldenSection[key]);
        const currentValue = JSON.stringify(currentSection[key]);

        if (goldenValue !== currentValue) {
          differences.push({
            section: sectionName,
            type: 'changed',
            field: key,
            golden_value: goldenSection[key],
            current_value: currentSection[key],
            severity: this.getSeverity(sectionName, key, 'changed')
          });
        }
      }
    }
  }

  /**
   * Get severity level for a configuration change
   */
  getSeverity(section, field, changeType) {
    // Check if this is a critical configuration section
    if (this.config.critical_changes.includes(section)) {
      return 'critical';
    }

    // Check for specific high-severity fields
    const criticalFields = [
      'password', 'key', 'secret', 'token', 'credential',
      'authentication', 'authorization', 'access_control',
      'firewall', 'acl', 'security_policy', 'nat'
    ];

    const fieldLower = field.toLowerCase();
    if (criticalFields.some(cf => fieldLower.includes(cf))) {
      return 'critical';
    }

    // Check change type
    if (changeType === 'missing' && section === 'security') {
      return 'high';
    }

    if (changeType === 'unexpected' && section === 'firewall') {
      return 'high';
    }

    return 'medium';
  }

  /**
   * Calculate configuration drift score
   */
  calculateDriftScore(differences) {
    if (!this.goldenBaseline) {
      return 0;
    }

    // Count total configuration fields
    const goldenConfig = this.goldenBaseline.router_configuration;
    let totalFields = 0;
    this.countFields(goldenConfig, totalFields);

    // Calculate drift based on severity
    let driftScore = 0;
    for (const diff of differences) {
      const severityWeight = {
        critical: 10,
        high: 5,
        medium: 2,
        low: 1
      };
      driftScore += severityWeight[diff.severity] || 1;
    }

    // Normalize to 0-100 scale
    const maxDrift = totalFields * 10;
    const normalizedScore = totalFields > 0 ? Math.min(100, (driftScore / maxDrift) * 100) : 0;

    return Math.round(normalizedScore);
  }

  /**
   * Count total fields in configuration object
   */
  countFields(obj, count) {
    if (typeof obj !== 'object' || obj === null) {
      return 1;
    }

    let total = 0;
    for (const value of Object.values(obj)) {
      if (typeof value === 'object' && value !== null) {
        total += this.countFields(value, total);
      } else {
        total += 1;
      }
    }

    return total;
  }

  /**
   * Analyze configuration differences and generate alerts
   */
  async analyzeDifferences(differences) {
    if (differences.length === 0) {
      this.logger.debug('No configuration differences detected');
      return;
    }

    this.logger.info('Configuration differences detected', {
      count: differences.length
    });

    // Group differences by severity
    const criticalDiffs = differences.filter(d => d.severity === 'critical');
    const highDiffs = differences.filter(d => d.severity === 'high');
    const mediumDiffs = differences.filter(d => d.severity === 'medium');

    // Record configuration changes
    for (const diff of differences) {
      this.metrics.recordConfigurationChange(
        diff.section,
        diff.type,
        diff.severity
      );
    }

    // Generate alert for critical differences
    if (criticalDiffs.length > 0) {
      this.alertDispatcher.dispatchAlert({
        type: 'configuration_tampering',
        severity: 'critical',
        title: 'Critical Configuration Changes Detected',
        description: `${criticalDiffs.length} critical configuration changes detected compared to golden baseline`,
        details: {
          router: this.routerConfig.host,
          critical_changes: criticalDiffs,
          total_differences: differences.length,
          recommended_action: 'IMMEDIATE INVESTIGATION REQUIRED. Configuration may have been tampered with.',
          timestamp: new Date().toISOString()
        }
      });
    }

    // Generate alert for high-severity differences
    if (highDiffs.length > 0) {
      this.alertDispatcher.dispatchAlert({
        type: 'configuration_drift',
        severity: 'high',
        title: 'High-Severity Configuration Changes Detected',
        description: `${highDiffs.length} high-severity configuration changes detected`,
        details: {
          router: this.routerConfig.host,
          high_changes: highDiffs,
          recommended_action: 'Review configuration changes and validate with security team.',
          timestamp: new Date().toISOString()
        }
      });
    }

    // Generate informational alert for medium differences
    if (mediumDiffs.length > 0 && criticalDiffs.length === 0 && highDiffs.length === 0) {
      this.alertDispatcher.dispatchAlert({
        type: 'configuration_change',
        severity: 'medium',
        title: 'Configuration Changes Detected',
        description: `${mediumDiffs.length} configuration changes detected`,
        details: {
          router: this.routerConfig.host,
          changes: mediumDiffs,
          recommended_action: 'Review changes and update golden baseline if intentional.',
          timestamp: new Date().toISOString()
        }
      });
    }
  }

  /**
   * Get current validation status
   */
  getStatus() {
    return {
      running: this.isRunning,
      golden_baseline_loaded: !!this.goldenBaseline,
      baseline_version: this.goldenBaseline?.metadata?.version,
      current_config_fetched: !!this.currentConfig
    };
  }
}

module.exports = ConfigurationValidator;