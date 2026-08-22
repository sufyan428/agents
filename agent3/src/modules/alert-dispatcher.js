/**
 * Alert Dispatcher Module
 *
 * Dispatches security alerts through multiple channels:
 * - Console output
 * - Log files
 * - Webhooks
 */

const axios = require('axios');
// axios-retry v4 exposes the callable on .default; v3 exported it directly.
const axiosRetry = require('axios-retry').default || require('axios-retry');

// Configure axios retry
axiosRetry(axios, {
  retries: 3,
  retryDelay: axiosRetry.exponentialDelay,
});

class AlertDispatcher {
  constructor(config, logger, metrics) {
    this.config = config;
    this.logger = logger;
    this.metrics = metrics;
    this.alertHistory = [];
    this.maxHistorySize = 1000;
  }

  /**
   * Dispatch an alert through configured channels
   * @param {Object} alert - Alert object
   */
  async dispatchAlert(alert) {
    try {
      // Validate alert structure
      this.validateAlert(alert);

      // Add timestamp and alert ID
      alert.id = this.generateAlertId();
      alert.timestamp = alert.details?.timestamp || new Date().toISOString();

      // Check if severity is enabled
      const severityConfig = this.config.severity[alert.severity.toLowerCase()];
      if (!severityConfig || !severityConfig.enabled) {
        this.logger.debug(`Alert severity ${alert.severity} is disabled, skipping`);
        return;
      }

      // Log to console
      if (this.config.channels.console) {
        this.dispatchToConsole(alert);
      }

      // Log to file
      if (this.config.channels.log) {
        this.dispatchToLog(alert);
      }

      // Send via webhook
      if (this.config.channels.webhook) {
        await this.dispatchToWebhook(alert);
      }

      // Record metrics
      this.metrics.recordAlert(alert.type, alert.severity, 'security_agent');

      // Add to history
      this.addToHistory(alert);

      this.logger.info('Alert dispatched successfully', {
        alert_id: alert.id,
        type: alert.type,
        severity: alert.severity,
      });
    } catch (error) {
      this.logger.error('Error dispatching alert:', error);
      this.metrics.recordAlertDispatch('error', 'failed');
    }
  }

  /**
   * Validate alert structure
   */
  validateAlert(alert) {
    const required = ['type', 'severity', 'title', 'description', 'details'];

    for (const field of required) {
      if (!alert[field]) {
        throw new Error(`Alert missing required field: ${field}`);
      }
    }

    const validSeverities = ['critical', 'high', 'medium', 'low'];
    if (!validSeverities.includes(alert.severity.toLowerCase())) {
      throw new Error(`Invalid severity: ${alert.severity}`);
    }
  }

  /**
   * Generate unique alert ID
   */
  generateAlertId() {
    return `alert-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Dispatch alert to console
   */
  dispatchToConsole(alert) {
    const severityIcons = {
      critical: '🚨',
      high: '⚠️',
      medium: 'ℹ️',
      low: '📋',
    };

    const icon = severityIcons[alert.severity.toLowerCase()] || '📋';
    const separator = '='.repeat(80);

    console.log(`\n${separator}`);
    console.log(`${icon} SECURITY ALERT [${alert.severity.toUpperCase()}]`);
    console.log(`ID: ${alert.id}`);
    console.log(`Timestamp: ${alert.timestamp}`);
    console.log(`Type: ${alert.type}`);
    console.log(`${separator}`);
    console.log(`Title: ${alert.title}`);
    console.log(`\nDescription: ${alert.description}`);
    console.log(`\nDetails:`);
    console.log(JSON.stringify(alert.details, null, 2));
    console.log(`${separator}\n`);
  }

  /**
   * Dispatch alert to log file
   */
  dispatchToLog(alert) {
    const logLevel = this.getLogLevelForSeverity(alert.severity);

    this.logger.log(logLevel, 'Security Alert', {
      alert_id: alert.id,
      timestamp: alert.timestamp,
      type: alert.type,
      severity: alert.severity,
      title: alert.title,
      description: alert.description,
      details: alert.details,
    });
  }

  /**
   * Get Winston log level for severity
   */
  getLogLevelForSeverity(severity) {
    const levelMap = {
      critical: 'error',
      high: 'error',
      medium: 'warn',
      low: 'info',
    };

    return levelMap[severity.toLowerCase()] || 'info';
  }

  /**
   * Dispatch alert via webhook
   */
  async dispatchToWebhook(alert) {
    try {
      const webhookConfig = this.config.webhook;

      if (!webhookConfig.url) {
        this.logger.warn('Webhook enabled but no URL configured');
        return;
      }

      const payload = {
        alert_id: alert.id,
        timestamp: alert.timestamp,
        type: alert.type,
        severity: alert.severity,
        title: alert.title,
        description: alert.description,
        details: alert.details,
        source: {
          name: 'security-id-agent',
          instance: process.env.AGENT_INSTANCE || 'unknown',
          router: process.env.ROUTER_HOST || 'unknown',
        },
      };

      const response = await axios({
        method: webhookConfig.method || 'POST',
        url: webhookConfig.url,
        headers: webhookConfig.headers || {},
        data: payload,
        timeout: 10000,
      });

      if (response.status >= 200 && response.status < 300) {
        this.logger.debug('Webhook alert sent successfully', {
          alert_id: alert.id,
          status: response.status,
        });
        this.metrics.recordAlertDispatch('webhook', 'success');
      } else {
        throw new Error(`Webhook returned status ${response.status}`);
      }
    } catch (error) {
      this.logger.error('Failed to send webhook alert:', error);
      this.metrics.recordAlertDispatch('webhook', 'failed');
    }
  }

  /**
   * Add alert to history
   */
  addToHistory(alert) {
    this.alertHistory.push(alert);

    // Maintain history size limit
    if (this.alertHistory.length > this.maxHistorySize) {
      this.alertHistory.shift();
    }
  }

  /**
   * Get alert history
   * @param {Object} filters - Optional filters
   * @returns {Array} Filtered alert history
   */
  getAlertHistory(filters = {}) {
    let filtered = [...this.alertHistory];

    if (filters.type) {
      filtered = filtered.filter((alert) => alert.type === filters.type);
    }

    if (filters.severity) {
      filtered = filtered.filter((alert) => alert.severity === filters.severity);
    }

    if (filters.since) {
      const sinceDate = new Date(filters.since);
      filtered = filtered.filter((alert) => new Date(alert.timestamp) >= sinceDate);
    }

    if (filters.limit) {
      filtered = filtered.slice(-filters.limit);
    }

    return filtered;
  }

  /**
   * Get alert statistics
   */
  getStatistics() {
    const stats = {
      total: this.alertHistory.length,
      by_severity: {},
      by_type: {},
      recent_alerts: [],
    };

    for (const alert of this.alertHistory) {
      // Count by severity
      stats.by_severity[alert.severity] = (stats.by_severity[alert.severity] || 0) + 1;

      // Count by type
      stats.by_type[alert.type] = (stats.by_type[alert.type] || 0) + 1;
    }

    // Get recent alerts (last 10)
    stats.recent_alerts = this.alertHistory.slice(-10);

    return stats;
  }

  /**
   * Clear alert history (useful for testing)
   */
  clearHistory() {
    this.alertHistory = [];
    this.logger.info('Alert history cleared');
  }
}

module.exports = AlertDispatcher;
