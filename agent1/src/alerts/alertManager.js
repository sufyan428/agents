/**
 * Alert Manager
 * Manages alert delivery through multiple channels (console, email, API)
 */

const logger = require('../utils/logger');
const axios = require('axios');
const nodemailer = require('nodemailer');

class AlertManager {
  constructor() {
    this.alertHistory = [];
    this.emailTransporter = null;
    this.apiEndpoint = process.env.ALERT_API_ENDPOINT || null;
    this.enabledChannels = {
      console: true,
      email: false,
      api: false
    };

    this.initializeEmailTransporter();
  }

  /**
   * Initialize email transporter
   */
  initializeEmailTransporter() {
    const emailConfig = {
      host: process.env.SMTP_HOST || 'localhost',
      port: process.env.SMTP_PORT || 587,
      secure: false,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
      }
    };

    if (process.env.SMTP_HOST) {
      try {
        this.emailTransporter = nodemailer.createTransport(emailConfig);
        this.enabledChannels.email = true;
        logger.info('Email alert channel enabled');
      } catch (error) {
        logger.error(`Failed to initialize email transporter: ${error.message}`);
      }
    }
  }

  /**
   * Send alert through all enabled channels
   */
  async sendAlert(alert) {
    logger.warn(`ALERT [${alert.severity.toUpperCase()}]: ${alert.message}`);

    // Add to history
    this.alertHistory.push({
      ...alert,
      sentAt: new Date().toISOString()
    });

    // Keep only last 1000 alerts in history
    if (this.alertHistory.length > 1000) {
      this.alertHistory.shift();
    }

    // Send to enabled channels
    const promises = [];

    if (this.enabledChannels.console) {
      promises.push(this.sendConsoleAlert(alert));
    }

    if (this.enabledChannels.email) {
      promises.push(this.sendEmailAlert(alert));
    }

    if (this.enabledChannels.api && this.apiEndpoint) {
      promises.push(this.sendAPIAlert(alert));
    }

    // Execute all sends in parallel
    await Promise.allSettled(promises);
  }

  /**
   * Send alert to console
   */
  async sendConsoleAlert(alert) {
    const timestamp = new Date().toLocaleString();
    
    console.log('\n' + '='.repeat(80));
    console.log(`🚨 ALERT [${alert.severity.toUpperCase()}]`);
    console.log(`⏰ Time: ${timestamp}`);
    console.log(`📍 Router: ${alert.router}`);
    console.log(`📊 Metric: ${alert.metric}`);
    console.log(`📈 Value: ${alert.value} (Threshold: ${alert.threshold})`);
    if (alert.details) {
      console.log(`ℹ️  Details: ${alert.details}`);
    }
    console.log('='.repeat(80) + '\n');
  }

  /**
   * Send alert via email
   */
  async sendEmailAlert(alert) {
    if (!this.emailTransporter) {
      return;
    }

    const mailOptions = {
      from: process.env.SMTP_FROM || 'monitoring-agent@localhost',
      to: process.env.ALERT_EMAIL_RECIPIENT || 'admin@localhost',
      subject: `[${alert.severity.toUpperCase()}] ${alert.router} - ${alert.metric} Alert`,
      text: this.formatAlertEmail(alert),
      html: this.formatAlertHTMLEmail(alert)
    };

    try {
      await this.emailTransporter.sendMail(mailOptions);
      logger.info(`Email alert sent for ${alert.router} - ${alert.metric}`);
    } catch (error) {
      logger.error(`Failed to send email alert: ${error.message}`);
    }
  }

  /**
   * Send alert to API endpoint
   */
  async sendAPIAlert(alert) {
    if (!this.apiEndpoint) {
      return;
    }

    try {
      await axios.post(this.apiEndpoint, {
        alert,
        timestamp: new Date().toISOString(),
        source: 'router-monitoring-agent'
      }, {
        headers: {
          'Content-Type': 'application/json'
        },
        timeout: 5000
      });

      logger.info(`API alert sent for ${alert.router} - ${alert.metric}`);
    } catch (error) {
      logger.error(`Failed to send API alert: ${error.message}`);
    }
  }

  /**
   * Format alert as plain text email
   */
  formatAlertEmail(alert) {
    return `
Router Monitoring Alert

Severity: ${alert.severity.toUpperCase()}
Router: ${alert.router}
Metric: ${alert.metric}
Value: ${alert.value}
Threshold: ${alert.threshold}
Timestamp: ${alert.timestamp}

Message:
${alert.message}

${alert.details ? `Details: ${alert.details}` : ''}

---
Sent by Router Monitoring Agent
`;
  }

  /**
   * Format alert as HTML email
   */
  formatAlertHTMLEmail(alert) {
    const severityColors = {
      warning: '#FFA500',
      critical: '#FF0000'
    };

    const color = severityColors[alert.severity] || '#000000';

    return `
<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: Arial, sans-serif; padding: 20px; }
    .alert-box { border: 2px solid ${color}; border-radius: 5px; padding: 20px; }
    .severity { color: ${color}; font-weight: bold; font-size: 1.2em; }
    .label { font-weight: bold; }
  </style>
</head>
<body>
  <div class="alert-box">
    <h2 style="margin-top: 0;">🚨 Router Monitoring Alert</h2>
    <p><span class="severity">Severity: ${alert.severity.toUpperCase()}</span></p>
    <p><span class="label">Router:</span> ${alert.router}</p>
    <p><span class="label">Metric:</span> ${alert.metric}</p>
    <p><span class="label">Value:</span> ${alert.value}</p>
    <p><span class="label">Threshold:</span> ${alert.threshold}</p>
    <p><span class="label">Timestamp:</span> ${alert.timestamp}</p>
    <hr>
    <p>${alert.message}</p>
    ${alert.details ? `<p><span class="label">Details:</span> ${alert.details}</p>` : ''}
  </div>
  <p style="font-size: 0.9em; color: #666;">Sent by Router Monitoring Agent</p>
</body>
</html>
`;
  }

  /**
   * Get alert history
   */
  getAlertHistory(limit = 100) {
    return this.alertHistory.slice(-limit);
  }

  /**
   * Get alert statistics
   */
  getAlertStats() {
    const stats = {
      total: this.alertHistory.length,
      bySeverity: {
        warning: 0,
        critical: 0
      },
      byMetric: {},
      byRouter: {}
    };

    this.alertHistory.forEach(alert => {
      stats.bySeverity[alert.severity] = (stats.bySeverity[alert.severity] || 0) + 1;
      stats.byMetric[alert.metric] = (stats.byMetric[alert.metric] || 0) + 1;
      stats.byRouter[alert.router] = (stats.byRouter[alert.router] || 0) + 1;
    });

    return stats;
  }

  /**
   * Clear alert history
   */
  clearHistory() {
    this.alertHistory = [];
    logger.info('Alert history cleared');
  }
}

module.exports = new AlertManager();