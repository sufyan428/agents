/**
 * Threshold Processor
 * Applies threshold rules to collected metrics and triggers alerts
 */

const logger = require('../utils/logger');
const config = require('../utils/config');
const alertManager = require('../alerts/alertManager');
const prometheus = require('../utils/prometheus');

class ThresholdProcessor {
  constructor() {
    this.thresholds = config.thresholds;
  }

  /**
   * Process SNMP metrics against thresholds
   */
  processSNMPMetrics(metrics) {
    const alerts = [];

    if (!metrics) {
      return alerts;
    }

    // Check CPU threshold
    if (metrics.cpu !== null) {
      const cpuAlert = this.checkThreshold(
        'cpu',
        metrics.cpu,
        metrics.router,
        this.thresholds.cpu
      );
      if (cpuAlert) {
        alerts.push(cpuAlert);
        prometheus.incrementAlert(metrics.router, cpuAlert.severity, 'cpu');
      }
    }

    // Check memory threshold
    if (metrics.memory !== null) {
      const memoryAlert = this.checkThreshold(
        'memory',
        parseFloat(metrics.memory),
        metrics.router,
        this.thresholds.memory
      );
      if (memoryAlert) {
        alerts.push(memoryAlert);
        prometheus.incrementAlert(metrics.router, memoryAlert.severity, 'memory');
      }
    }

    // Check temperature threshold
    if (metrics.temperature !== null) {
      const tempAlert = this.checkThreshold(
        'temperature',
        metrics.temperature,
        metrics.router,
        this.thresholds.temperature
      );
      if (tempAlert) {
        alerts.push(tempAlert);
        prometheus.incrementAlert(metrics.router, tempAlert.severity, 'temperature');
      }
    }

    // Send all triggered alerts
    alerts.forEach(alert => {
      alertManager.sendAlert(alert);
    });

    return alerts;
  }

  /**
   * Process bandwidth metrics against thresholds
   */
  processBandwidthMetrics(routerName, interfaceName, utilizationPercentage) {
    const alerts = [];

    const bandwidthAlert = this.checkThreshold(
      'bandwidth',
      utilizationPercentage,
      routerName,
      this.thresholds.bandwidth
    );

    if (bandwidthAlert) {
      bandwidthAlert.details = `Interface: ${interfaceName}`;
      alerts.push(bandwidthAlert);
      prometheus.incrementAlert(routerName, bandwidthAlert.severity, 'bandwidth');
      alertManager.sendAlert(bandwidthAlert);
    }

    return alerts;
  }

  /**
   * Process latency metrics against thresholds
   */
  processLatencyMetrics(routerName, target, latencyMs) {
    const alerts = [];

    const latencyAlert = this.checkThreshold(
      'latency',
      latencyMs,
      routerName,
      this.thresholds.latency
    );

    if (latencyAlert) {
      latencyAlert.details = `Target: ${target}`;
      alerts.push(latencyAlert);
      prometheus.incrementAlert(routerName, latencyAlert.severity, 'latency');
      alertManager.sendAlert(latencyAlert);
    }

    return alerts;
  }

  /**
   * Process packet loss metrics against thresholds
   */
  processPacketLossMetrics(routerName, packetLossPercentage) {
    const alerts = [];

    const packetLossAlert = this.checkThreshold(
      'packet_loss',
      packetLossPercentage,
      routerName,
      this.thresholds.packet_loss
    );

    if (packetLossAlert) {
      alerts.push(packetLossAlert);
      prometheus.incrementAlert(routerName, packetLossAlert.severity, 'packet_loss');
      alertManager.sendAlert(packetLossAlert);
    }

    return alerts;
  }

  /**
   * Process failed login metrics against thresholds
   */
  processFailedLogins(routerName, failedLoginsCount) {
    const alerts = [];

    const loginAlert = this.checkThreshold(
      'failed_logins',
      failedLoginsCount,
      routerName,
      this.thresholds.failed_logins
    );

    if (loginAlert) {
      loginAlert.details = `Failed login attempts: ${failedLoginsCount}`;
      alerts.push(loginAlert);
      prometheus.incrementAlert(routerName, loginAlert.severity, 'failed_logins');
      alertManager.sendAlert(loginAlert);
    }

    return alerts;
  }

  /**
   * Process interface errors against thresholds
   */
  processInterfaceErrors(routerName, interfaceName, errorsPerMinute) {
    const alerts = [];

    const errorsAlert = this.checkThreshold(
      'interface_errors',
      errorsPerMinute,
      routerName,
      this.thresholds.interface_errors
    );

    if (errorsAlert) {
      errorsAlert.details = `Interface: ${interfaceName}, Errors: ${errorsPerMinute}/min`;
      alerts.push(errorsAlert);
      prometheus.incrementAlert(routerName, errorsAlert.severity, 'interface_errors');
      alertManager.sendAlert(errorsAlert);
    }

    return alerts;
  }

  /**
   * Check if a value exceeds threshold and create alert if needed
   */
  checkThreshold(metric, value, routerName, threshold) {
    if (!threshold) {
      return null;
    }

    const now = new Date().toISOString();
    let severity = null;

    if (value >= threshold.critical) {
      severity = 'critical';
    } else if (value >= threshold.warning) {
      severity = 'warning';
    }

    if (severity) {
      return {
        metric,
        severity,
        router: routerName,
        value,
        threshold: threshold[severity],
        timestamp: now,
        message: `${metric.toUpperCase()} ${severity} on ${routerName}: ${value}${this.getUnit(metric)}`
      };
    }

    return null;
  }

  /**
   * Get unit for metric
   */
  getUnit(metric) {
    const units = {
      cpu: '%',
      memory: '%',
      temperature: '°C',
      bandwidth: '%',
      latency: 'ms',
      packet_loss: '%'
    };

    return units[metric] || '';
  }

  /**
   * Update thresholds from configuration
   */
  updateThresholds(newThresholds) {
    this.thresholds = newThresholds;
    logger.info('Thresholds updated');
  }

  /**
   * Get current thresholds
   */
  getThresholds() {
    return this.thresholds;
  }
}

module.exports = new ThresholdProcessor();