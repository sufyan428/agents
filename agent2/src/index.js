#!/usr/bin/env node

const ConfigLoader = require('./config/configLoader');
const Logger = require('./utils/logger');
const PrometheusMetrics = require('./metrics/prometheusMetrics');
const SNMPMonitor = require('./monitors/snmpMonitor');
const PingMonitor = require('./monitors/pingMonitor');
const HeartbeatChecker = require('./modules/heartbeatChecker');
const FailoverManager = require('./modules/failoverManager');
const ConfigSync = require('./modules/configSync');
const SyslogListener = require('./modules/syslogListener');
const ExpressServer = require('./server/expressServer');

class ResilienceFailoverAgent {
  constructor() {
    this.configLoader = new ConfigLoader();
    this.config = null;
    this.logger = null;
    this.metrics = null;
    this.snmpMonitor = null;
    this.pingMonitor = null;
    this.heartbeatChecker = null;
    this.failoverManager = null;
    this.configSync = null;
    this.syslogListener = null;
    this.expressServer = null;
    this.isRunning = false;
  }

  async initialize() {
    try {
      // Load configuration
      this.config = this.configLoader.load();
      console.log('Configuration loaded successfully');

      // Initialize logger
      this.logger = new Logger(this.config);
      this.logger.info('========================================');
      this.logger.info('Resilience & Failover Agent Starting');
      this.logger.info('========================================');

      // Initialize metrics
      this.metrics = new PrometheusMetrics(this.config);
      this.logger.info('Prometheus metrics initialized');

      // Initialize monitors
      this.snmpMonitor = new SNMPMonitor(this.config, this.logger, this.metrics);
      this.pingMonitor = new PingMonitor(this.config, this.logger, this.metrics);
      this.logger.info('Network monitors initialized');

      // Initialize heartbeat checker
      this.heartbeatChecker = new HeartbeatChecker(
        this.config,
        this.logger,
        this.metrics,
        this.snmpMonitor,
        this.pingMonitor,
      );
      this.logger.info('Heartbeat checker initialized');

      // Initialize failover manager
      this.failoverManager = new FailoverManager(this.config, this.logger, this.metrics);
      this.logger.info('Failover manager initialized');

      // Initialize config sync
      this.configSync = new ConfigSync(this.config, this.logger, this.metrics);
      this.logger.info('Configuration sync initialized');

      // Initialize syslog listener
      this.syslogListener = new SyslogListener(this.config, this.logger, this.metrics);
      this.logger.info('Syslog listener initialized');

      // Initialize express server
      this.expressServer = new ExpressServer(
        this.config,
        this.logger,
        this.metrics,
        this.heartbeatChecker,
        this.failoverManager,
        this.configSync,
        this.syslogListener,
      );
      this.logger.info('Express server initialized');

      // The heartbeat loop is started exactly once, in start(). It used to be
      // started here as well, with a different callback: the second call
      // overwrote this.cronJob and orphaned the first loop, so two heartbeat
      // loops ran concurrently, every failover event was handled twice, and
      // stop() could only ever cancel one of them.

      this.logger.info('All components initialized successfully');
      return true;
    } catch (error) {
      console.error('Failed to initialize agent:', error.message);
      if (this.logger) {
        this.logger.error('Agent initialization failed', {
          error: error.message,
          stack: error.stack,
        });
      }
      return false;
    }
  }

  async start() {
    try {
      // Wait for startup delay if configured
      const startupDelay = this.config.advanced?.startup_delay || 0;
      if (startupDelay > 0) {
        this.logger.info(`Waiting ${startupDelay}ms before starting...`);
        await this.sleep(startupDelay);
      }

      // Start syslog listener
      this.syslogListener.start();

      // Start configuration sync
      this.configSync.start();

      // Start express server
      await this.expressServer.start();

      // Start heartbeat checker
      this.heartbeatChecker.start((event) => {
        this.handleFailoverEvent(event);
      });

      this.isRunning = true;
      this.logger.info('========================================');
      this.logger.info('Resilience & Failover Agent Started');
      this.logger.info('========================================');
      this.logger.info('Agent Information:', {
        primary_router: this.config.primary.host,
        backup_router: this.config.backup.host,
        failover_enabled: this.config.failover.enabled,
        sync_enabled: this.config.sync.enabled,
        metrics_port: this.config.metrics.port,
      });

      // Initial health check
      await this.performInitialHealthCheck();

      return true;
    } catch (error) {
      this.logger.error('Failed to start agent', {
        error: error.message,
        stack: error.stack,
      });
      throw error;
    }
  }

  async performInitialHealthCheck() {
    this.logger.info('Performing initial health check...');

    try {
      // Check primary router
      const primaryHealth = await this.snmpMonitor.checkHealth(this.config.primary);
      this.logger.info('Primary router initial health', {
        status: primaryHealth.success ? 'healthy' : 'unhealthy',
        response_time: primaryHealth.responseTime,
      });

      // Check backup router
      const backupHealth = await this.snmpMonitor.checkHealth(this.config.backup);
      this.logger.info('Backup router initial health', {
        status: backupHealth.success ? 'healthy' : 'unhealthy',
        response_time: backupHealth.responseTime,
      });

      // Update metrics
      this.metrics.updateRouterPrimaryStatus(primaryHealth.success);
      this.metrics.updateRouterBackupStatus(backupHealth.success);
    } catch (error) {
      this.logger.error('Initial health check failed', {
        error: error.message,
      });
    }
  }

  async handleFailoverEvent(event) {
    this.logger.info('Handling failover event', { event });

    try {
      // Update config sync's active router
      if (event.type === 'failover') {
        this.configSync.setCurrentActiveRouter('backup');
      } else if (event.type === 'failback') {
        this.configSync.setCurrentActiveRouter('primary');
      }

      // Handle failover
      await this.failoverManager.handleFailover(event);
    } catch (error) {
      this.logger.error('Failed to handle failover event', {
        error: error.message,
      });
    }
  }

  async stop() {
    if (!this.isRunning) {
      return;
    }

    this.logger.info('Stopping Resilience & Failover Agent...');

    try {
      // Stop heartbeat checker
      this.heartbeatChecker.stop();

      // Stop configuration sync
      this.configSync.stop();

      // Stop syslog listener
      this.syslogListener.stop();

      // Stop express server
      await this.expressServer.stop();

      // Save final state
      this.failoverManager.saveState();

      this.isRunning = false;
      this.logger.info('Resilience & Failover Agent stopped');
    } catch (error) {
      this.logger.error('Error during agent shutdown', {
        error: error.message,
      });
    }
  }

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// Main execution
async function main() {
  const agent = new ResilienceFailoverAgent();

  try {
    const initialized = await agent.initialize();

    if (initialized) {
      await agent.start();

      // Handle graceful shutdown
      process.on('SIGTERM', async () => {
        agent.logger.info('SIGTERM received, shutting down...');
        await agent.stop();
        process.exit(0);
      });

      process.on('SIGINT', async () => {
        agent.logger.info('SIGINT received, shutting down...');
        await agent.stop();
        process.exit(0);
      });

      process.on('uncaughtException', (error) => {
        agent.logger.error('Uncaught exception', {
          error: error.message,
          stack: error.stack,
        });
        process.exit(1);
      });

      process.on('unhandledRejection', (reason, promise) => {
        agent.logger.error('Unhandled rejection', {
          reason: reason,
          promise: promise,
        });
      });

      // Keep the process running
      agent.logger.info('Agent is running. Press Ctrl+C to stop.');
    } else {
      console.error('Failed to initialize agent');
      process.exit(1);
    }
  } catch (error) {
    console.error('Fatal error:', error.message);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  main();
}

module.exports = ResilienceFailoverAgent;
