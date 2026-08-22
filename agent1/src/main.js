/**
 * Main entry point for the Router Monitoring Agent
 * Orchestrates collectors, processors, and alerts
 */

const express = require('express');
const logger = require('./utils/logger');
const config = require('./utils/config');
const prometheus = require('./utils/prometheus');
const { snmpCollector, syslogCollector } = require('./collectors');
const { thresholdProcessor } = require('./processors');

class MonitoringAgent {
  constructor() {
    this.app = express();
    this.port = process.env.PORT || 3000;
    // We explicitly define the host as 0.0.0.0 to allow Docker access
    this.host = '0.0.0.0'; 
    this.metricsPort = process.env.METRICS_PORT || 9090;
    this.running = false;
    this.pollIntervals = new Map();
  }

  /**
   * Initialize the monitoring agent
   */
  async initialize() {
    try {
      logger.info('Initializing Router Monitoring Agent...');

      // Load configuration
      config.load();

      // Initialize Prometheus metrics
      logger.info('Prometheus metrics initialized');

      // Initialize collectors
      snmpCollector.initialize();
      syslogCollector.initialize();

      // Setup Express server
      this.setupExpress();

      logger.info('Monitoring Agent initialized successfully');
    } catch (error) {
      logger.error(`Failed to initialize monitoring agent: ${error.message}`);
      throw error;
    }
  }

  /**
   * Setup Express server for metrics and health
   */
  setupExpress() {
    // Metrics endpoint for Prometheus
    this.app.get('/metrics', async (req, res) => {
      try {
        const metrics = await prometheus.getMetrics();
        res.set('Content-Type', prometheus.register.contentType);
        res.send(metrics);
      } catch (error) {
        logger.error(`Failed to get metrics: ${error.message}`);
        res.status(500).send('Failed to get metrics');
      }
    });

    // Health check endpoint
    this.app.get('/health', (req, res) => {
      res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        routersMonitored: config.getEnabledRouters().length
      });
    });

    // Status endpoint
    this.app.get('/status', (req, res) => {
      const { alertManager } = require('./alerts');
      
      res.json({
        status: 'running',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        collectors: {
          snmp: 'active',
          syslog: syslogCollector.server ? 'active' : 'disabled'
        },
        alertStats: alertManager.getAlertStats(),
        thresholds: thresholdProcessor.getThresholds()
      });
    });

    // Alert history endpoint
    this.app.get('/alerts', (req, res) => {
      const { alertManager } = require('./alerts');
      const limit = parseInt(req.query.limit) || 100;
      res.json(alertManager.getAlertHistory(limit));
    });

    // Test endpoint for manual testing
    this.app.post('/test', (req, res) => {
      const { alertManager } = require('./alerts');
      
      const testAlert = {
        metric: 'test',
        severity: 'warning',
        router: 'TestRouter',
        value: 85,
        threshold: 80,
        timestamp: new Date().toISOString(),
        message: 'Test alert sent manually',
        details: 'This is a test alert for monitoring purposes'
      };

      alertManager.sendAlert(testAlert);
      res.json({ message: 'Test alert sent', alert: testAlert });
    });

    logger.info('Express server configured');
  }

  /**
   * Start monitoring - collect metrics at intervals
   */
  startMonitoring() {
    const routers = config.getEnabledRouters();
    
    routers.forEach(router => {
      const interval = (router.poll_interval || 30) * 1000;
      
      const intervalId = setInterval(async () => {
        try {
          // Collect SNMP metrics
          const metrics = await snmpCollector.collect(router.name);
          
          if (metrics) {
            // Process metrics against thresholds
            thresholdProcessor.processSNMPMetrics(metrics);
          }

          // Process failed logins from syslog
          const loginStats = syslogCollector.getFailedLoginStats();
          if (loginStats.lastMinute > 0) {
            thresholdProcessor.processFailedLogins(router.name, loginStats.lastMinute);
          }

        } catch (error) {
          logger.error(`Error monitoring ${router.name}: ${error.message}`);
        }
      }, interval);

      this.pollIntervals.set(router.name, intervalId);
      
      logger.info(`Started monitoring ${router.name} (interval: ${router.poll_interval}s)`);
    });

    // Cleanup interval for old events
    setInterval(() => {
      syslogCollector.clearOldEvents();
    }, 60000); // Every minute

    this.running = true;
    logger.info('Monitoring started');
  }

  /**
   * Start the monitoring agent
   */
  async start() {
    try {
      await this.initialize();

      // Start monitoring
      this.startMonitoring();

      // Start Express server
      this.app.listen(this.port, () => {
        logger.info(`Monitoring Agent running on port ${this.port}`);
        logger.info(`Metrics available at http://localhost:${this.port}/metrics`);
        logger.info(`Health check at http://localhost:${this.port}/health`);
        logger.info(`Status at http://localhost:${this.port}/status`);
      });

      // Handle graceful shutdown
      this.setupShutdownHandlers();

    } catch (error) {
      logger.error(`Failed to start monitoring agent: ${error.message}`);
      process.exit(1);
    }
  }

  /**
   * Setup shutdown handlers
   */
  setupShutdownHandlers() {
    const shutdown = async (signal) => {
      logger.info(`${signal} received, shutting down gracefully...`);

      // Stop monitoring intervals
      this.pollIntervals.forEach((intervalId, routerName) => {
        clearInterval(intervalId);
        logger.info(`Stopped monitoring ${routerName}`);
      });

      // Close collectors
      snmpCollector.close();
      syslogCollector.close();

      logger.info('Monitoring Agent stopped');
      process.exit(0);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  }
}

// Start the agent if this file is run directly
if (require.main === module) {
  const agent = new MonitoringAgent();
  agent.start();
}

module.exports = MonitoringAgent;
