const express = require('express'); // Router only; the server itself comes from the factory
const {
  createServer,
  simulationHealthCheck,
  FindingStore,
  mountFindingsRoute,
} = require('@ragent/agent-common');
const logger = require('./utils/logger');
const ConfigLoader = require('./utils/configLoader');
const Metrics = require('./utils/metrics');
const SyslogListener = require('./utils/syslogListener');
const PolicyChecker = require('./modules/policyChecker');
const ConfigManager = require('./modules/configManager');
const SelfHealing = require('./modules/selfHealing');
const AuditReporter = require('./modules/auditReporter');
const TaskScheduler = require('./modules/taskScheduler');

class AutomationGovernanceAgent {
  constructor() {
    this.app = null;
    this.agentServer = null;
    this.configLoader = new ConfigLoader();
    this.config = null;
    this.routerConfig = null;
    this.routers = [];
    this.metrics = null;
    this.syslogListener = null;
    this.policyChecker = null;
    this.configManager = null;
    this.selfHealing = null;
    this.auditReporter = null;
    this.taskScheduler = null;
    // Normalized findings, polled by agent6 for cross-agent correlation.
    this.findings = new FindingStore({ resolveAfterMs: 15 * 60 * 1000 });
  }

  async initialize() {
    try {
      logger.info('Initializing Automation & Governance Agent');

      // Load configurations
      await this.configLoader.loadAllConfigs();
      this.config = this.configLoader.getConfig();
      this.routerConfig = this.configLoader.getRouterConfig();
      this.routers = this.configLoader.getRouters();

      // Validate configuration
      const validation = this.configLoader.validateConfig();
      if (!validation.valid) {
        throw new Error(`Invalid configuration: ${validation.errors.join(', ')}`);
      }

      // Initialize metrics
      this.metrics = new Metrics(this.config);

      // Initialize modules
      // The policy checker queries real received syslog for syslog-type policies.
      this.policyChecker = new PolicyChecker(this.config, this.syslogListener);
      await this.policyChecker.loadPolicies();

      this.configManager = new ConfigManager(this.config);
      this.selfHealing = new SelfHealing(this.config, this.policyChecker, this.configManager);
      this.auditReporter = new AuditReporter(this.config);

      // Initialize task scheduler
      this.taskScheduler = new TaskScheduler(
        this.config,
        this.policyChecker,
        this.configManager,
        this.selfHealing,
        this.auditReporter,
      );

      // Start syslog listener
      if (this.config.syslog?.enabled) {
        this.syslogListener = new SyslogListener(this.config);
        this.syslogListener.start();
        // The policy checker is constructed before this point, so it is given
        // the listener here rather than in its constructor. Without this the
        // syslog policy type would report "not evaluated" forever - which is
        // at least honest, but useless.
        this.policyChecker.syslogListener = this.syslogListener;
      }

      // Schedule automated tasks
      this.taskScheduler.scheduleTasks(this.routers);

      // Setup Express server

      // Log initialization complete
      await this.auditReporter.logEvent({
        eventType: 'agent_startup',
        routerName: 'ALL',
        routerHost: 'N/A',
        severity: 'info',
        details: {
          routers: this.routers.length,
          policies: this.policyChecker.policies.length,
          scheduledTasks: this.taskScheduler.getScheduledTasks().length,
        },
      });

      logger.info('Automation & Governance Agent initialized successfully');
    } catch (error) {
      logger.error(`Failed to initialize agent: ${error.message}`);
      throw error;
    }
  }

  setupExpress() {
    const app = this.app;

    // /health and /metrics come from the shared factory. The governance
    // registry is separate and exposed alongside it.
    app.get('/metrics/governance', async (req, res, next) => {
      try {
        res.set('Content-Type', 'text/plain');
        res.send(await this.metrics.getMetrics());
      } catch (error) {
        next(error);
      }
    });

    // API endpoints
    this.setupApiRoutes();

    // Error handling
    this.app.use((err, req, res, _next) => {
      logger.error(`Unhandled error: ${err.message}`);
      res.status(500).json({
        error: 'Internal server error',
        message: err.message,
      });
    });
  }

  setupApiRoutes() {
    const api = express.Router();

    // Status endpoint
    api.get('/status', (req, res) => {
      res.json({
        status: 'running',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        routers: this.routers.map((r) => ({
          name: r.name,
          host: r.host,
          location: r.location,
        })),
        policies: this.policyChecker.policies.length,
        scheduledTasks: this.taskScheduler.getScheduledTasks(),
      });
    });

    // Router status
    api.get('/routers', (req, res) => {
      res.json({
        routers: this.routers.map((r) => ({
          name: r.name,
          host: r.host,
          location: r.location,
          type: r.type,
        })),
      });
    });

    // Policies endpoint
    api.get('/policies', (req, res) => {
      res.json({
        policies: this.policyChecker.policies,
      });
    });

    // Compliance check endpoint
    api.post('/compliance/check', async (req, res) => {
      try {
        const results = await this.policyChecker.checkAllRouters(this.routers);
        res.json({
          timestamp: new Date().toISOString(),
          results,
        });
      } catch (error) {
        logger.error(`Compliance check failed: ${error.message}`);
        res.status(500).json({ error: error.message });
      }
    });

    // Trigger self-healing
    api.post('/healing/trigger', async (req, res) => {
      try {
        const { router, violations } = req.body;

        if (!router) {
          return res.status(400).json({ error: 'Router name is required' });
        }

        const routerObj = this.routers.find((r) => r.name === router);
        if (!routerObj) {
          return res.status(404).json({ error: 'Router not found' });
        }

        const violationsToHeal = violations || [];
        const results = await this.selfHealing.checkAndHeal(routerObj, violationsToHeal);

        res.json(results);
      } catch (error) {
        logger.error(`Self-healing trigger failed: ${error.message}`);
        res.status(500).json({ error: error.message });
      }
    });

    // Configuration backup endpoint
    api.post('/config/backup', async (req, res) => {
      try {
        const { router } = req.body;

        let routersToBackup = this.routers;
        if (router) {
          const routerObj = this.routers.find((r) => r.name === router);
          if (!routerObj) {
            return res.status(404).json({ error: 'Router not found' });
          }
          routersToBackup = [routerObj];
        }

        const results = [];
        for (const r of routersToBackup) {
          const result = await this.configManager.backupConfig(r);
          results.push(result);
        }

        res.json({
          timestamp: new Date().toISOString(),
          results,
        });
      } catch (error) {
        logger.error(`Backup failed: ${error.message}`);
        res.status(500).json({ error: error.message });
      }
    });

    // List backups
    api.get('/config/backups', async (req, res) => {
      try {
        const { router } = req.query;
        const backups = await this.configManager.listBackups(router);
        res.json({ backups });
      } catch (error) {
        logger.error(`Failed to list backups: ${error.message}`);
        res.status(500).json({ error: error.message });
      }
    });

    // Restore configuration
    api.post('/config/restore', async (req, res) => {
      try {
        const { router, backupFile } = req.body;

        if (!router || !backupFile) {
          return res.status(400).json({ error: 'Router and backupFile are required' });
        }

        const routerObj = this.routers.find((r) => r.name === router);
        if (!routerObj) {
          return res.status(404).json({ error: 'Router not found' });
        }

        const result = await this.configManager.restoreConfig(routerObj, backupFile);
        res.json(result);
      } catch (error) {
        logger.error(`Restore failed: ${error.message}`);
        res.status(500).json({ error: error.message });
      }
    });

    // Generate reports
    api.post('/reports/generate', async (req, res) => {
      try {
        const { reportType } = req.body;

        let report;
        switch (reportType) {
          case 'compliance': {
            const policyResults = await this.policyChecker.checkAllRouters(this.routers);
            report = await this.auditReporter.generateComplianceReport(this.routers, policyResults);
            break;
          }
          case 'audit':
            report = await this.auditReporter.generateAuditReport('24h');
            break;
          case 'configuration': {
            const configChanges = this.configManager.getConfigChanges();
            const backups = await this.configManager.listBackups();
            report = await this.auditReporter.generateConfigurationReport(configChanges, backups);
            break;
          }
          case 'self_healing': {
            const healingActions = this.selfHealing.getHealingActions();
            const healingMetrics = this.selfHealing.getMetrics();
            report = await this.auditReporter.generateSelfHealingReport(
              healingActions,
              healingMetrics,
            );
            break;
          }
          default:
            return res.status(400).json({ error: 'Invalid report type' });
        }

        res.json(report);
      } catch (error) {
        logger.error(`Report generation failed: ${error.message}`);
        res.status(500).json({ error: error.message });
      }
    });

    // Manual task execution
    api.post('/tasks/execute', async (req, res) => {
      try {
        const { taskName } = req.body;

        if (!taskName) {
          return res.status(400).json({ error: 'Task name is required' });
        }

        const result = await this.taskScheduler.executeManualTask(taskName, this.routers);
        res.json(result);
      } catch (error) {
        logger.error(`Task execution failed: ${error.message}`);
        res.status(500).json({ error: error.message });
      }
    });

    // Get task history
    api.get('/tasks/history', (req, res) => {
      const { limit } = req.query;
      const history = this.taskScheduler.getTaskHistory(parseInt(limit) || 50);
      res.json({ history });
    });

    // Syslog messages
    api.get('/syslog/messages', (req, res) => {
      if (!this.syslogListener) {
        return res.status(503).json({ error: 'Syslog listener not enabled' });
      }

      const { limit, search, severity, source } = req.query;
      const filter = {};

      if (severity) filter.severity = parseInt(severity);
      if (source) filter.source = source;
      if (search) filter.search = search;

      const messages = this.syslogListener.getMessages(
        Object.keys(filter).length > 0 ? filter : null,
        parseInt(limit) || 100,
      );

      res.json({ messages });
    });

    // Syslog statistics
    api.get('/syslog/statistics', (req, res) => {
      if (!this.syslogListener) {
        return res.status(503).json({ error: 'Syslog listener not enabled' });
      }

      const stats = this.syslogListener.getStatistics();
      res.json(stats);
    });

    // Metrics endpoint (JSON format)
    api.get('/metrics/json', (req, res) => {
      res.json({
        policyChecker: this.policyChecker.getMetrics(),
        configManager: this.configManager.getMetrics(),
        selfHealing: this.selfHealing.getMetrics(),
        auditReporter: this.auditReporter.getMetrics(),
        taskScheduler: this.taskScheduler.getMetrics(),
      });
    });

    // Mount API routes
    this.app.use('/api', api);
  }

  async start() {
    const serverConfig = this.configLoader.getServerConfig();
    const port = Number(process.env.PORT) || serverConfig.port || 9091;
    const host = process.env.BIND_HOST || serverConfig.host || '127.0.0.1';
    const token = (process.env.AGENT_API_TOKEN || '').trim() || undefined;

    if (!token) {
      logger.warn(
        'AGENT_API_TOKEN is not set. Mutating /api routes will refuse with 503. ' +
          'This agent can write configuration to network devices, so they do not ' +
          'run unauthenticated.',
      );
    }

    this.agentServer = createServer({
      agent: 'agent5-automation',
      logger,
      port,
      host,
      healthPath: serverConfig.health_path || '/health',
      metricsPath: serverConfig.metrics_path || '/metrics',
      authToken: token,
      corsOrigins: (process.env.AGENT_CORS_ORIGINS || '')
        .split(',')
        .map((o) => o.trim())
        .filter(Boolean),
      healthChecks: () => {
        const cfg = this.configLoader.getConfig?.() || {};
        const heal = cfg.self_healing || {};
        return [
          {
            name: 'routers_configured',
            status: this.routers.length > 0 ? 'healthy' : 'degraded',
            message: this.routers.length > 0 ? undefined : 'no routers configured',
            simulated: false,
          },
          {
            name: 'self_healing',
            status: 'healthy',
            message: heal.dry_run === false ? 'ARMED - will write to devices' : 'dry run',
            simulated: false,
          },
          {
            // Several policy checks return a placeholder verdict rather than
            // reading the device. Surfaced here so a "compliant" result is
            // never mistaken for a verified one.
            name: 'policy_checks',
            status: 'degraded',
            message:
              'syslog and configuration policy checks are not yet implemented against real devices',
            simulated: true,
          },
          simulationHealthCheck('agent5'),
        ];
      },
    });

    this.app = this.agentServer.app;
    this.setupExpress();
    mountFindingsRoute(this.app, this.findings, 'agent5-automation');
    await this.agentServer.listen();
    logger.info(`API: http://${host}:${port}/api`);
  }

  async shutdown() {
    logger.info('Shutting down Automation & Governance Agent');

    try {
      // Stop scheduled tasks
      if (this.taskScheduler) {
        this.taskScheduler.stopAllTasks();
      }

      // Stop syslog listener
      if (this.syslogListener) {
        this.syslogListener.stop();
      }

      // Close server
      if (this.server) {
        await new Promise((resolve) => this.server.close(resolve));
      }

      logger.info('Shutdown complete');
      process.exit(0);
    } catch (error) {
      logger.error(`Error during shutdown: ${error.message}`);
      process.exit(1);
    }
  }
}

// Start the agent
const agent = new AutomationGovernanceAgent();
agent
  .initialize()
  .then(() => agent.start())
  .catch((error) => {
    logger.error(`Failed to start agent: ${error.message}`);
    process.exit(1);
  });

module.exports = AutomationGovernanceAgent;
