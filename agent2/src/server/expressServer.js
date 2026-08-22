const { createServer } = require('@ragent/agent-common');
const Logger = require('../utils/logger');

class ExpressServer {
  constructor(config, logger, metrics, heartbeatChecker, failoverManager, configSync, syslogListener) {
    this.config = config;
    this.logger = logger;
    this.metrics = metrics;
    this.heartbeatChecker = heartbeatChecker;
    this.failoverManager = failoverManager;
    this.configSync = configSync;
    this.syslogListener = syslogListener;
    
    // Built in start(), so the port and bind host from config are available.
    this.agentServer = null;
    this.app = null;
  }

  setupRoutes(app) {
    const metricsConfig = this.config.metrics || {};
    
    // /health and /metrics come from the shared factory. The agent's own
    // Prometheus registry is still exposed, under a distinct path, because it
    // holds the failover counters the factory registry knows nothing about.
    app.get('/metrics/failover', async (req, res, next) => {
      try {
        res.set('Content-Type', this.metrics.getContentType());
        res.send(await this.metrics.getMetrics());
      } catch (error) { next(error); }
    });

    // Status endpoint
    app.get('/status', (req, res) => {
      const status = this.getStatus();
      res.json(status);
    });

    // Failover history endpoint
    app.get('/failover/history', (req, res) => {
      const history = this.failoverManager.getStatus();
      res.json(history);
    });

    // Manual failover endpoint (use with caution)
    app.post('/failover/manual', async (req, res) => {
      try {
        const { target } = req.body;
        
        if (target !== 'backup' && target !== 'primary') {
          return res.status(400).json({
            error: 'Invalid target. Must be "backup" or "primary"'
          });
        }

        const eventType = target === 'backup' ? 'failover' : 'failback';
        const result = await this.failoverManager.handleFailover({
          type: eventType,
          reason: 'manual-trigger'
        });

        res.json(result);
      } catch (error) {
        this.logger.error('Manual failover failed', {
          error: error.message
        });
        res.status(500).json({
          error: 'Manual failover failed',
          message: error.message
        });
      }
    });

    // Config sync status endpoint
    app.get('/sync/status', (req, res) => {
      const status = this.configSync.getSyncStatus();
      res.json(status);
    });

    // Trigger manual config sync
    app.post('/sync/trigger', async (req, res) => {
      try {
        const { reason = 'manual-trigger' } = req.body;
        const result = await this.configSync.triggerManualSync(reason);
        res.json(result);
      } catch (error) {
        this.logger.error('Manual config sync failed', {
          error: error.message
        });
        res.status(500).json({
          error: 'Manual config sync failed',
          message: error.message
        });
      }
    });

    // Syslog stats endpoint
    app.get('/syslog/stats', (req, res) => {
      const stats = this.syslogListener.getStats();
      res.json(stats);
    });

    // Heartbeat status endpoint
    app.get('/heartbeat/status', (req, res) => {
      const status = this.heartbeatChecker.getStatus();
      res.json(status);
    });

    // Router configuration endpoint
    app.get('/config', (req, res) => {
      // Return sanitized config (no passwords)
      const sanitizedConfig = this.sanitizeConfig(this.config);
      res.json(sanitizedConfig);
    });

    // Reload configuration endpoint
    app.post('/config/reload', (req, res) => {
      try {
        // This would reload the configuration from file
        res.json({
          success: true,
          message: 'Configuration reload triggered'
        });
      } catch (error) {
        res.status(500).json({
          error: 'Configuration reload failed',
          message: error.message
        });
      }
    });

  }

  getHealthStatus() {
    const heartbeatStatus = this.heartbeatChecker.getStatus();
    const failoverStatus = this.failoverManager.getStatus();
    const syncStatus = this.configSync.getSyncStatus();
    
    const healthy = (
      heartbeatStatus.primary.health === 'healthy' ||
      heartbeatStatus.backup.health === 'healthy'
    );

    return {
      healthy,
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      heartbeat: heartbeatStatus,
      failover: failoverStatus,
      sync: syncStatus
    };
  }

  getStatus() {
    return {
      agent: {
        name: 'resilience-failover-agent',
        version: '1.0.0',
        uptime: process.uptime(),
        nodeVersion: process.version,
        platform: process.platform
      },
      heartbeat: this.heartbeatChecker.getStatus(),
      failover: this.failoverManager.getStatus(),
      sync: this.configSync.getSyncStatus(),
      syslog: this.syslogListener.getStats(),
      config: {
        primary: this.config.primary?.host,
        backup: this.config.backup?.host,
        failoverEnabled: this.config.failover?.enabled,
        syncEnabled: this.config.sync?.enabled
      }
    };
  }

  sanitizeConfig(config) {
    // Remove sensitive information from config
    const sanitized = JSON.parse(JSON.stringify(config));
    
    const removePasswords = (obj) => {
      for (const key in obj) {
        if (key.toLowerCase().includes('password') ||
            key.toLowerCase().includes('secret') ||
            key.toLowerCase().includes('community')) {
          obj[key] = '***REDACTED***';
        } else if (typeof obj[key] === 'object' && obj[key] !== null) {
          removePasswords(obj[key]);
        }
      }
    };
    
    removePasswords(sanitized);
    return sanitized;
  }

  start() {
    const port = Number(process.env.PORT) || this.config.server?.port || this.config.metrics?.port || 9091;
    const host = process.env.BIND_HOST || this.config.server?.host || '127.0.0.1';
    const token = (process.env.AGENT_API_TOKEN || '').trim() || undefined;

    if (!token) {
      this.logger.warn(
        'AGENT_API_TOKEN is not set. POST /failover/manual and /sync/trigger will ' +
        'refuse with 503 - an unauthenticated caller must never be able to flip a router.'
      );
    }

    this.agentServer = createServer({
      agent: 'agent2-resilience',
      logger: this.logger,
      port,
      host,
      authToken: token,
      corsOrigins: (process.env.AGENT_CORS_ORIGINS || '').split(',').map((o) => o.trim()).filter(Boolean),
      healthChecks: () => {
        const hb = this.heartbeatChecker.getStatus();
        // Router reachability is DEGRADED, not unhealthy. The agent is doing
        // its job correctly by reporting that a device is unreachable; saying
        // "unhealthy" made supervisors restart a working process and drove the
        // AI layer to treat every poll as an anomaly worth a model call.
        const routerCheck = (name, state) => ({
          name,
          status: state.health === 'healthy' ? 'healthy' : 'degraded',
          message: state.health === 'healthy' ? undefined : `${name} is ${state.health}`,
          simulated: false
        });
        return [
          routerCheck('primary_router', hb.primary),
          routerCheck('backup_router', hb.backup),
          {
            name: 'heartbeat_loop',
            status: hb.isActive ? 'healthy' : 'unhealthy',
            message: hb.isActive ? undefined : 'heartbeat loop is not running',
            simulated: false
          }
        ];
      }
    });

    this.app = this.agentServer.app;
    this.setupRoutes(this.app);
    return this.agentServer.listen();
  }

  stop() {
    return this.agentServer ? this.agentServer.close() : Promise.resolve();
  }
}

module.exports = ExpressServer;
