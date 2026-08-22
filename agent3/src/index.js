#!/usr/bin/env node

/**
 * Security & Intrusion Detection Agent
 * 
 * Main entry point for the security monitoring agent that protects
 * mission-critical router environments by detecting:
 * - Unauthorized access attempts
 * - Suspicious traffic patterns
 * - Configuration tampering
 * 
 * @author NinjaTech AI
 * @version 1.0.0
 */

const { createServer, simulationHealthCheck } = require('@ragent/agent-common');

// Import modules
const ConfigLoader = require('./config/config-loader');
const PrometheusMetrics = require('./utils/prometheus-metrics');
const Logger = require('./utils/logger');
const AuthenticationMonitor = require('./modules/authentication-monitor');
const TrafficAnalyzer = require('./modules/traffic-analyzer');
const ConfigurationValidator = require('./modules/configuration-validator');
const AlertDispatcher = require('./modules/alert-dispatcher');
const SyslogServer = require('./protocols/syslog-server');
const SnmpTrapListener = require('./protocols/snmp-trap-listener');
const IcmpMonitor = require('./protocols/icmp-monitor');

class SecurityIDAgent {
  constructor(configPath) {
    this.configPath = configPath || './config/router.yml';
    this.config = null;
    this.logger = null;
    this.metrics = null;
    this.modules = {};
    this.running = false;
    this.server = null;
  }

  async initialize() {
    try {
      // Load configuration
      this.config = ConfigLoader.load(this.configPath);
      
      // Initialize logger
      this.logger = Logger.create(this.config.logging);
      this.logger.info('Initializing Security & Intrusion Detection Agent');
      this.logger.info(`Configuration loaded from: ${this.configPath}`);
      this.logger.info(`Monitoring router: ${this.config.router.host}`);

      // Initialize Prometheus metrics
      this.metrics = new PrometheusMetrics(this.config.prometheus);
      
      // Initialize alert dispatcher
      this.modules.alertDispatcher = new AlertDispatcher(
        this.config.alerts,
        this.logger,
        this.metrics
      );

      // Initialize core security modules
      this.initializeModules();

      this.logger.info('All modules initialized successfully');
    } catch (error) {
      console.error('Failed to initialize agent:', error);
      throw error;
    }
  }

  initializeModules() {
    // Authentication Monitoring Module
    this.modules.authentication = new AuthenticationMonitor(
      this.config.security.authentication,
      this.logger,
      this.metrics,
      this.modules.alertDispatcher
    );

    // Traffic Analysis Module
    this.modules.traffic = new TrafficAnalyzer(
      this.config.security.traffic,
      this.logger,
      this.metrics,
      this.modules.alertDispatcher
    );

    // Configuration Validation Module
    this.modules.configuration = new ConfigurationValidator(
      this.config.security.configuration,
      this.config.router,
      this.logger,
      this.metrics,
      this.modules.alertDispatcher
    );

    // Protocol listeners
    if (this.config.syslog.enabled) {
      this.modules.syslog = new SyslogServer(
        this.config.syslog,
        this.logger,
        this.metrics,
        this.modules.authentication,
        this.modules.traffic
      );
    }

    if (this.config.router.snmp) {
      this.modules.snmp = new SnmpTrapListener(
        this.config.router.snmp,
        this.logger,
        this.metrics,
        this.modules.alertDispatcher
      );
    }

    if (this.config.icmp.enabled) {
      this.modules.icmp = new IcmpMonitor(
        this.config.icmp,
        this.config.router.host,
        this.logger,
        this.metrics,
        this.modules.alertDispatcher
      );
    }
  }

  async start() {
    if (this.running) {
      this.logger.warn('Agent is already running');
      return;
    }

    try {
      this.logger.info('Starting Security & Intrusion Detection Agent');
      
      // Start Prometheus metrics server
      if (this.config.prometheus.enabled) {
        await this.startMetricsServer();
      }

      // Start protocol listeners
      if (this.modules.syslog) {
        await this.modules.syslog.start();
        this.logger.info('Syslog server started');
      }

      if (this.modules.snmp) {
        await this.modules.snmp.start();
        this.logger.info('SNMP trap listener started');
      }

      if (this.modules.icmp) {
        await this.modules.icmp.start();
        this.logger.info('ICMP monitor started');
      }

      // Start periodic configuration validation
      if (this.config.security.configuration.enabled) {
        await this.modules.configuration.start();
        this.logger.info('Configuration validation started');
      }

      // Start traffic baseline collection
      await this.modules.traffic.start();
      this.logger.info('Traffic analyzer started');

      // Update agent status
      this.metrics.agentStatus.set(1);
      this.running = true;

      this.logger.info('Security & Intrusion Detection Agent started successfully');
      this.logger.info(`Prometheus metrics available at: http://0.0.0.0:${this.config.prometheus.port}${this.config.prometheus.path}`);

    } catch (error) {
      this.logger.error('Failed to start agent:', error);
      this.metrics.agentStatus.set(0);
      throw error;
    }
  }

  async startMetricsServer() {
    const port = Number(process.env.PORT) || this.config.prometheus.port;
    const host = process.env.BIND_HOST || this.config.prometheus.host || '127.0.0.1';

    this.agentServer = createServer({
      agent: 'agent3-security',
      logger: this.logger,
      port,
      host,
      metricsPath: this.config.prometheus.path || '/metrics',
      authToken: (process.env.AGENT_API_TOKEN || '').trim() || undefined,
      corsOrigins: (process.env.AGENT_CORS_ORIGINS || '').split(',').map((o) => o.trim()).filter(Boolean),
      healthChecks: () => [
        ...Object.entries(this.modules).map(([name, mod]) => ({
          name,
          status: mod && typeof mod.isRunning === 'function'
            ? (mod.isRunning() ? 'healthy' : 'degraded')
            : 'healthy',
          message: undefined,
          simulated: false
        })),
        simulationHealthCheck('agent3')
      ]
    });

    const app = this.agentServer.app;

    // The agent's own registry carries the security counters; the factory
    // registry only has process metrics, so both are exposed.
    app.get('/metrics/security', async (req, res, next) => {
      try {
        res.set('Content-Type', this.metrics.register.contentType);
        res.end(await this.metrics.register.metrics());
      } catch (error) { next(error); }
    });

    app.get('/info', (req, res) => {
      res.json({
        name: this.config.agent.name,
        instance: this.config.agent.instance,
        version: require('../package.json').version,
        environment: this.config.agent.environment,
        router: this.config.router.host,
        capabilities: [
          'authentication-monitoring',
          'traffic-analysis',
          'configuration-validation',
          'syslog-ingestion',
          'snmp-trap-monitoring',
          'icmp-monitoring'
        ]
      });
    });

    await this.agentServer.listen();
  }

  async stop() {
    if (!this.running) {
      return;
    }

    this.logger.info('Stopping Security & Intrusion Detection Agent');

    // Stop all modules
    if (this.modules.syslog) {
      await this.modules.syslog.stop();
    }

    if (this.modules.snmp) {
      await this.modules.snmp.stop();
    }

    if (this.modules.icmp) {
      await this.modules.icmp.stop();
    }

    if (this.modules.configuration) {
      await this.modules.configuration.stop();
    }

    if (this.modules.traffic) {
      await this.modules.traffic.stop();
    }

    // Stop metrics server
    if (this.server) {
      await new Promise((resolve) => {
        this.server.close(resolve);
      });
    }

    this.metrics.agentStatus.set(0);
    this.running = false;

    this.logger.info('Security & Intrusion Detection Agent stopped');
  }
}

// Main execution
async function main() {
  const agent = new SecurityIDAgent();

  try {
    await agent.initialize();
    await agent.start();

    // Graceful shutdown handling
    process.on('SIGTERM', async () => {
      agent.logger.info('Received SIGTERM signal');
      await agent.stop();
      process.exit(0);
    });

    process.on('SIGINT', async () => {
      agent.logger.info('Received SIGINT signal');
      await agent.stop();
      process.exit(0);
    });

    // Handle uncaught errors
    process.on('uncaughtException', (error) => {
      agent.logger.error('Uncaught exception:', error);
      agent.metrics.agentStatus.set(0);
    });

    process.on('unhandledRejection', (reason, _promise) => {
      agent.logger.error('Unhandled rejection:', reason);
    });

  } catch (error) {
    console.error('Failed to start agent:', error);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  main();
}

module.exports = SecurityIDAgent;