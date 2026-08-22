const cron = require('node-cron');

class HeartbeatChecker {
  constructor(config, logger, metrics, snmpMonitor, pingMonitor) {
    this.config = config;
    this.logger = logger;
    this.metrics = metrics;
    this.snmpMonitor = snmpMonitor;
    this.pingMonitor = pingMonitor;

    this.missedHeartbeats = {
      primary: 0,
      backup: 0,
    };

    this.primaryHealthStatus = 'unknown';
    this.backupHealthStatus = 'unknown';

    this.cronJob = null;
    this.failoverCallback = null;
  }

  start(callback) {
    this.failoverCallback = callback;
    const interval = this.config.failover?.heartbeat_interval || 5000;
    const cronExpression = this.intervalToCron(interval);

    this.cronJob = cron.schedule(cronExpression, () => {
      this.checkHeartbeats();
    });

    this.logger.info('Heartbeat checker started', {
      interval: `${interval}ms`,
      cron_expression: cronExpression,
    });
  }

  stop() {
    if (this.cronJob) {
      this.cronJob.stop();
      this.logger.info('Heartbeat checker stopped');
    }
  }

  intervalToCron(intervalMs) {
    const seconds = Math.floor(intervalMs / 1000);
    if (seconds < 60) {
      return `*/${seconds} * * * * *`;
    }
    return `0 */${Math.floor(seconds / 60)} * * * *`;
  }

  async checkHeartbeats() {
    try {
      this.logger.debug('Checking heartbeats for both routers');

      // Check primary router
      const primaryResult = await this.checkRouterHealth(this.config.primary, 'primary');
      this.processHealthResult('primary', primaryResult);

      // Check backup router
      const backupResult = await this.checkRouterHealth(this.config.backup, 'backup');
      this.processHealthResult('backup', backupResult);

      // Update metrics
      this.updateHealthMetrics();

      // Check for failover conditions
      this.checkFailoverConditions();
    } catch (error) {
      this.logger.error('Heartbeat check failed', {
        error: error.message,
        stack: error.stack,
      });
    }
  }

  async checkRouterHealth(routerConfig, _routerType) {
    const methods = ['snmp', 'ping'];
    const results = [];

    for (const method of methods) {
      try {
        let result;
        if (method === 'snmp') {
          result = await this.snmpMonitor.checkHealth(routerConfig);
        } else {
          result = await this.pingMonitor.checkHealth(routerConfig);
        }

        results.push({
          method,
          ...result,
        });

        // If any method succeeds, consider router healthy
        if (result.success) {
          return {
            status: 'healthy',
            method,
            results,
          };
        }
      } catch (error) {
        results.push({
          method,
          success: false,
          error: error.message,
        });
      }
    }

    return {
      status: 'unhealthy',
      results,
    };
  }

  processHealthResult(routerType, result) {
    const maxMissed = this.config.failover?.max_missed_heartbeats || 3;

    if (result.status === 'healthy') {
      // Router is healthy, reset missed heartbeats
      if (this.missedHeartbeats[routerType] > 0) {
        this.logger.info(`${routerType} router recovered`, {
          previous_missed: this.missedHeartbeats[routerType],
          method: result.method,
        });
      }

      this.missedHeartbeats[routerType] = 0;
      this[`${routerType}HealthStatus`] = 'healthy';
    } else {
      // Router is unhealthy, increment missed heartbeats
      this.missedHeartbeats[routerType]++;
      this[`${routerType}HealthStatus`] = 'unhealthy';

      this.metrics.recordMissedHeartbeat(routerType);

      this.logger.warn(`${routerType} router heartbeat missed`, {
        missed_count: this.missedHeartbeats[routerType],
        max_missed: maxMissed,
        results: result.results,
      });
    }
  }

  updateHealthMetrics() {
    const primaryIsUp = this.primaryHealthStatus === 'healthy';
    const backupIsUp = this.backupHealthStatus === 'healthy';

    this.metrics.updateRouterPrimaryStatus(primaryIsUp);
    this.metrics.updateRouterBackupStatus(backupIsUp);
    this.metrics.updateAgentHealth(primaryIsUp || backupIsUp);
  }

  checkFailoverConditions() {
    const maxMissed = this.config.failover?.max_missed_heartbeats || 3;
    const failoverEnabled = this.config.failover?.enabled !== false;

    if (!failoverEnabled) {
      return;
    }

    // Check if primary router needs failover
    if (this.missedHeartbeats.primary >= maxMissed) {
      if (this.backupHealthStatus === 'healthy') {
        this.triggerFailover('primary');
      } else {
        this.logger.critical('Both primary and backup routers are down!', {
          primary_missed: this.missedHeartbeats.primary,
          backup_missed: this.missedHeartbeats.backup,
        });
      }
    }

    // Check for failback conditions
    if (
      this.config.failover?.auto_failback &&
      this.primaryHealthStatus === 'healthy' &&
      this.backupHealthStatus === 'healthy'
    ) {
      // Only consider failback if we're currently in failover state
      // This would be managed by the FailoverManager
    }
  }

  triggerFailover(failedRouter) {
    const reason = `${failedRouter} router failed (${this.missedHeartbeats[failedRouter]} missed heartbeats)`;

    this.logger.critical('Triggering failover', {
      failed_router: failedRouter,
      missed_heartbeats: this.missedHeartbeats[failedRouter],
      reason,
    });

    if (this.failoverCallback) {
      this.failoverCallback({
        type: 'failover',
        failedRouter,
        reason,
        timestamp: new Date().toISOString(),
      });
    }
  }

  getStatus() {
    return {
      primary: {
        health: this.primaryHealthStatus,
        missedHeartbeats: this.missedHeartbeats.primary,
      },
      backup: {
        health: this.backupHealthStatus,
        missedHeartbeats: this.missedHeartbeats.backup,
      },
      isActive: this.cronJob !== null,
    };
  }

  resetMissedHeartbeats(routerType) {
    if (routerType === 'primary' || routerType === 'backup') {
      this.missedHeartbeats[routerType] = 0;
      this.logger.info(`Reset missed heartbeats for ${routerType} router`);
    }
  }
}

module.exports = HeartbeatChecker;
