/**
 * ICMP Monitor Module
 * 
 * Monitors router availability and connectivity using ICMP (ping)
 */

const ping = require('ping');

class IcmpMonitor {
  constructor(config, targetHost, logger, metrics, alertDispatcher) {
    this.config = config;
    this.targetHost = targetHost;
    this.logger = logger;
    this.metrics = metrics;
    this.alertDispatcher = alertDispatcher;

    this.monitoringInterval = null;
    this.isRunning = false;
    this.pingCount = 0;
    this.successCount = 0;
    this.failureCount = 0;
    this.lastSuccessTime = null;
    this.lastFailureTime = null;
    this.consecutiveFailures = 0;
  }

  /**
   * Start ICMP monitoring
   */
  async start() {
    try {
      this.logger.info('Starting ICMP monitor', {
        target_host: this.targetHost,
        interval_seconds: this.config.interval
      });

      // Perform initial ping
      await this.performPing();

      // Start periodic monitoring
      this.monitoringInterval = setInterval(async () => {
        await this.performPing();
      }, this.config.interval * 1000);

      this.isRunning = true;
      this.logger.info('ICMP monitor started');

    } catch (error) {
      this.logger.error('Failed to start ICMP monitor:', error);
      throw error;
    }
  }

  /**
   * Stop ICMP monitoring
   */
  async stop() {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
    }

    this.isRunning = false;
    this.logger.info('ICMP monitor stopped');
  }

  /**
   * Perform ICMP ping
   */
  async performPing() {
    const startTime = Date.now();

    try {
      this.pingCount++;

      const result = await ping.promise.probe(this.targetHost, {
        timeout: this.config.timeout / 1000, // Convert to seconds
        extra: ['-c', '1']
      });

      const responseTime = (Date.now() - startTime) / 1000;

      if (result.alive) {
        this.handleSuccessfulPing(result, responseTime);
      } else {
        this.handleFailedPing(result);
      }

    } catch (error) {
      this.logger.error('Error performing ping:', error);
      this.handleFailedPing({ error: error.message });
    }
  }

  /**
   * Handle successful ping
   */
  handleSuccessfulPing(result, responseTime) {
    this.successCount++;
    this.lastSuccessTime = new Date().toISOString();
    this.consecutiveFailures = 0;

    // Update metrics
    this.metrics.recordIcmpPing('success');
    this.metrics.recordIcmpResponseTime(responseTime);

    this.logger.debug('ICMP ping successful', {
      host: this.targetHost,
      response_time: responseTime.toFixed(3),
      packet_loss: result.packetLoss
    });

    // Check for unusually high response times
    if (responseTime > 1.0) {
      this.logger.warn('High ICMP response time detected', {
        host: this.targetHost,
        response_time: responseTime.toFixed(3)
      });

      this.alertDispatcher.dispatchAlert({
        type: 'high_latency',
        severity: responseTime > 3.0 ? 'high' : 'medium',
        title: 'High Network Latency Detected',
        description: `ICMP ping to ${this.targetHost} took ${responseTime.toFixed(3)} seconds`,
        details: {
          host: this.targetHost,
          response_time: responseTime.toFixed(3),
          recommended_action: 'Check network congestion and routing',
          timestamp: new Date().toISOString()
        }
      });
    }
  }

  /**
   * Handle failed ping
   */
  handleFailedPing(result) {
    this.failureCount++;
    this.lastFailureTime = new Date().toISOString();
    this.consecutiveFailures++;

    // Update metrics
    this.metrics.recordIcmpPing('failed');

    this.logger.warn('ICMP ping failed', {
      host: this.targetHost,
      consecutive_failures: this.consecutiveFailures,
      error: result.error || 'Host unreachable'
    });

    // Check if we've had multiple consecutive failures
    if (this.consecutiveFailures >= 3) {
      const severity = this.consecutiveFailures >= 5 ? 'critical' : 'high';

      this.alertDispatcher.dispatchAlert({
        type: 'host_unreachable',
        severity: severity,
        title: 'Router Unreachable',
        description: `${this.consecutiveFailures} consecutive ICMP ping failures to ${this.targetHost}`,
        details: {
          host: this.targetHost,
          consecutive_failures: this.consecutiveFailures,
          total_failures: this.failureCount,
          total_success: this.successCount,
          last_success: this.lastSuccessTime,
          recommended_action: severity === 'critical'
            ? 'CRITICAL: Router may be down or disconnected. Immediate investigation required.'
            : 'Investigate connectivity issue and check router status.',
          timestamp: this.lastFailureTime
        }
      });

      this.metrics.recordThreat('host_unreachable', severity);
    }
  }

  /**
   * Check if monitor is running
   */
  isRunning() {
    return this.isRunning;
  }

  /**
   * Get statistics
   */
  getStatistics() {
    const totalPings = this.pingCount;
    const successRate = totalPings > 0 ? ((this.successCount / totalPings) * 100).toFixed(2) : 0;

    return {
      running: this.isRunning,
      target_host: this.targetHost,
      total_pings: totalPings,
      successful_pings: this.successCount,
      failed_pings: this.failureCount,
      success_rate: `${successRate}%`,
      consecutive_failures: this.consecutiveFailures,
      last_success: this.lastSuccessTime,
      last_failure: this.lastFailureTime,
      monitoring_interval: this.config.interval
    };
  }

  /**
   * Reset monitoring state (useful for testing)
   */
  reset() {
    this.pingCount = 0;
    this.successCount = 0;
    this.failureCount = 0;
    this.lastSuccessTime = null;
    this.lastFailureTime = null;
    this.consecutiveFailures = 0;

    this.logger.info('ICMP monitor state reset');
  }
}

module.exports = IcmpMonitor;