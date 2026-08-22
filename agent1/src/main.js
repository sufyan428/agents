/**
 * Main entry point for the Router Monitoring Agent
 * Orchestrates collectors, processors, and alerts
 */

const { createServer, simulationHealthCheck, FindingStore, mountFindingsRoute } = require('@ragent/agent-common');
const BaselineProcessor = require('./processors/baselineProcessor');
const logger = require('./utils/logger');
const config = require('./utils/config');
const prometheus = require('./utils/prometheus');
const { snmpCollector, syslogCollector } = require('./collectors');
const { thresholdProcessor } = require('./processors');

class MonitoringAgent {
  constructor() {
    this.server = null;
    // Normalized findings, polled by agent6 for cross-agent correlation.
    this.findings = new FindingStore({ resolveAfterMs: 5 * 60 * 1000 });
    this.baselineProcessor = null;
    this.app = null;
    this.port = Number(process.env.PORT) || 3000;
    // Loopback by default. This listener exposes metrics, alert history and a
    // test-alert trigger; reaching it from another host is opt-in via
    // BIND_HOST, and the Docker image sets that explicitly.
    this.host = process.env.BIND_HOST || '127.0.0.1';
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

      // Baseline-aware processing, built after config so it can read the
      // configured thresholds.
      this.baselineProcessor = new BaselineProcessor({
        findingStore: this.findings,
        thresholds: config.thresholds
      });

      // Initialize collectors
      snmpCollector.initialize();
      syslogCollector.initialize();

      // The HTTP server is built in start(), once config is loaded.

      logger.info('Monitoring Agent initialized successfully');
    } catch (error) {
      logger.error(`Failed to initialize monitoring agent: ${error.message}`);
      throw error;
    }
  }

  /**
   * Setup Express server for metrics and health
   */
  setupRoutes(app) {
    // /health and /metrics come from the shared server factory, but the
    // factory's registry only holds process metrics. Every router_* metric
    // this agent produces lives on its own registry, which the conversion to
    // the factory left unexposed - so the monitoring agent was serving no
    // monitoring data at all.
    app.get('/metrics/router', async (req, res, next) => {
      try {
        res.set('Content-Type', prometheus.register.contentType);
        res.send(await prometheus.getMetrics());
      } catch (error) { next(error); }
    });

    // Status endpoint
    app.get('/status', (req, res) => {
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
        activeConditions: alertManager.getActiveConditions(),
        findings: this.findings.summary(),
        baselines: this.baselineProcessor ? this.baselineProcessor.describe() : null,
        thresholds: thresholdProcessor.getThresholds()
      });
    });

    // Alert history endpoint
    app.get('/alerts', (req, res) => {
      const { alertManager } = require('./alerts');
      // Clamp: an unbounded or negative limit is a trivial way to make the
      // process serialise its entire history on demand.
      const raw = Number.parseInt(req.query.limit, 10);
      const limit = Number.isFinite(raw) ? Math.min(Math.max(raw, 1), 1000) : 100;
      res.json(alertManager.getAlertHistory(limit));
    });

    // Fires a real alert through every enabled channel, including email.
    // A mutating route, so the factory requires a bearer token - previously
    // anyone who could reach the port could make this agent send mail.
    app.post('/test', (req, res) => {
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

    logger.info('Routes configured');
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
            // Configured thresholds still drive alert delivery.
            thresholdProcessor.processSNMPMetrics(metrics);

            // Baselining runs alongside and emits normalized findings, which
            // is what agent6 correlates and what catches a departure from
            // normal that never crosses a configured line.
            const at = new Date();
            if (metrics.cpu !== null && metrics.cpu !== undefined) {
              this.baselineProcessor.process(router.name, 'cpu', Number(metrics.cpu), { unit: '%', at });
            }
            if (metrics.memory !== null && metrics.memory !== undefined) {
              this.baselineProcessor.process(router.name, 'memory', Number(metrics.memory), { unit: '%', at });
            }
            for (const iface of metrics.interfaces || []) {
              if (Number.isFinite(Number(iface.errors))) {
                this.baselineProcessor.process(
                  `${router.name}/${iface.name}`, 'interface_errors', Number(iface.errors), { at }
                );
              }
            }
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
    this.cleanupInterval = setInterval(() => {
      syslogCollector.clearOldEvents();
    }, 60000); // Every minute

    // Emit a resolution notice for conditions that have stopped recurring.
    // Without this an operator sees an incident begin and never learns it
    // ended, which is half a monitoring system.
    const { alertManager } = require('./alerts');
    this.resolveInterval = setInterval(() => {
      alertManager.sweepResolved().catch((err) =>
        logger.error(`Resolution sweep failed: ${err.message}`)
      );
      // Findings that stopped recurring are resolved too, so agent6 sees an
      // incident end rather than only ever seeing it begin.
      for (const r of this.findings.sweep()) {
        logger.info(`Finding resolved: ${r.finding.title} after ${Math.round(r.durationMs / 1000)}s`);
      }
    }, 60000);

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

      // Start HTTP server
      const token = (process.env.AGENT_API_TOKEN || '').trim() || undefined;
      if (!token) {
        logger.warn(
          'AGENT_API_TOKEN is not set. POST /test (which sends real alert email) ' +
          'will refuse with 503.'
        );
      }

      this.server = createServer({
        agent: 'agent1-monitoring',
        logger,
        port: this.port,
        host: this.host,
        authToken: token,
        corsOrigins: (process.env.AGENT_CORS_ORIGINS || '').split(',').map((o) => o.trim()).filter(Boolean),
        healthChecks: () => {
          const routers = config.getEnabledRouters();
          return [
            {
              name: 'config_loaded',
              status: routers.length > 0 ? 'healthy' : 'unhealthy',
              message: routers.length > 0 ? undefined : 'no enabled routers in config',
              simulated: false
            },
            {
              name: 'syslog_listener',
              // Not listening is degraded, not fatal: SNMP polling still works.
              status: syslogCollector.server ? 'healthy' : 'degraded',
              message: syslogCollector.server ? undefined : 'syslog listener is not bound',
              simulated: false
            },
            simulationHealthCheck('agent1')
          ];
        }
      });

      this.app = this.server.app;
      this.setupRoutes(this.app);
      mountFindingsRoute(this.app, this.findings, 'agent1-monitoring');
      await this.server.listen();
      logger.info(`Status at http://${this.host}:${this.port}/status`);

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
      if (this.cleanupInterval) clearInterval(this.cleanupInterval);
      if (this.resolveInterval) clearInterval(this.resolveInterval);

      // Close collectors
      snmpCollector.close();
      syslogCollector.close();
      if (this.server) await this.server.close();

      logger.info('Monitoring Agent stopped');
      process.exitCode = 0;
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
