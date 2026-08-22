/**
 * Alert Manager
 * Manages alert delivery through multiple channels (console, email, API)
 */

const logger = require('../utils/logger');
const axios = require('axios');
const nodemailer = require('nodemailer');
const AlertDeduper = require('./alertDeduper');

/**
 * Escapes text destined for an HTML email body.
 *
 * Alert fields are not all trustworthy: router names come from config, but
 * details and messages can carry text derived from syslog, which is
 * unauthenticated UDP input. Interpolating that into HTML unescaped let a
 * crafted log line inject markup into an operator's inbox.
 */
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

class AlertManager {
  constructor() {
    this.alertHistory = [];
    this.emailTransporter = null;
    this.deduper = new AlertDeduper({
      cooldownMs: Number(process.env.ALERT_COOLDOWN_MS) || 15 * 60 * 1000,
      resolveAfterMs: Number(process.env.ALERT_RESOLVE_AFTER_MS) || 5 * 60 * 1000,
    });
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
    // Suppression decides delivery, not recording: the history keeps every
    // occurrence so /alerts still shows the true picture, while the channels
    // only fire when there is something new to say.
    const decision = this.deduper.consider(alert);

    this.alertHistory.push({
      ...alert,
      sentAt: new Date().toISOString(),
      delivered: decision.deliver,
      suppressionReason: decision.reason,
      occurrence: decision.occurrence
    });

    if (this.alertHistory.length > 1000) {
      this.alertHistory.shift();
    }

    if (!decision.deliver) {
      logger.debug(
        `Alert suppressed (${alert.router}/${alert.metric}, occurrence ${decision.occurrence}) - ` +
        'condition unchanged since the last notification'
      );
      return;
    }

    const prefix = decision.reason === 'escalated' ? 'ESCALATED' : 'ALERT';
    logger.warn(`${prefix} [${alert.severity.toUpperCase()}]: ${alert.message}`);

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
      // Strip CR/LF: a newline in a header value is header injection, which
      // would let crafted content add its own To/Bcc lines.
      subject: `[${alert.severity.toUpperCase()}] ${alert.router} - ${alert.metric} Alert`
        .replace(/[\r\n]+/g, ' ')
        .slice(0, 200),
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

    const e = {
      severity: escapeHtml(alert.severity).toUpperCase(),
      router: escapeHtml(alert.router),
      metric: escapeHtml(alert.metric),
      value: escapeHtml(alert.value),
      threshold: escapeHtml(alert.threshold),
      timestamp: escapeHtml(alert.timestamp),
      message: escapeHtml(alert.message),
      details: alert.details ? escapeHtml(alert.details) : null
    };

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
    <p><span class="severity">Severity: ${e.severity}</span></p>
    <p><span class="label">Router:</span> ${e.router}</p>
    <p><span class="label">Metric:</span> ${e.metric}</p>
    <p><span class="label">Value:</span> ${e.value}</p>
    <p><span class="label">Threshold:</span> ${e.threshold}</p>
    <p><span class="label">Timestamp:</span> ${e.timestamp}</p>
    <hr>
    <p>${e.message}</p>
    ${e.details ? `<p><span class="label">Details:</span> ${e.details}</p>` : ''}
  </div>
  <p style="font-size: 0.9em; color: #666;">Sent by Router Monitoring Agent</p>
</body>
</html>
`;
  }

  /**
   * Emits a resolution notice for every condition that has stopped recurring.
   *
   * Called on a timer by the agent. Without it an operator sees an incident
   * start and never learns it ended.
   */
  async sweepResolved() {
    const resolved = this.deduper.collectResolved();
    for (const item of resolved) {
      const minutes = Math.round(item.durationMs / 60000);
      const alert = {
        metric: item.metric,
        severity: 'info',
        router: item.router,
        value: 'resolved',
        threshold: 'n/a',
        timestamp: new Date().toISOString(),
        message: `RESOLVED: ${item.metric} on ${item.router} recovered after ${minutes}m (${item.occurrences} occurrences)`,
        details: `First seen ${item.firstSeen}, last seen ${item.lastSeen}`
      };
      logger.info(alert.message);
      this.alertHistory.push({ ...alert, sentAt: new Date().toISOString(), delivered: true, suppressionReason: 'resolved' });

      const promises = [];
      if (this.enabledChannels.console) promises.push(this.sendConsoleAlert(alert));
      if (this.enabledChannels.email) promises.push(this.sendEmailAlert(alert));
      if (this.enabledChannels.api && this.apiEndpoint) promises.push(this.sendAPIAlert(alert));
      await Promise.allSettled(promises);
    }
    return resolved.length;
  }

  /** Conditions currently being suppressed, for /status. */
  getActiveConditions() {
    return this.deduper.activeConditions();
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