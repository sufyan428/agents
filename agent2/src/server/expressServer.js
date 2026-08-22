const express = require('express');
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
    
    this.app = express();
    this.server = null;
    
    this.setupMiddleware();
    this.setupRoutes();
  }

  setupMiddleware() {
    this.app.use(express.json());
    this.app.use(express.urlencoded({ extended: true }));
    
    // Request logging
    this.app.use((req, res, next) => {
      this.logger.debug(`${req.method} ${req.path}`, {
        ip: req.ip
      });
      next();
    });
  }

  setupRoutes() {
    const metricsConfig = this.config.metrics || {};
    
    // Health check endpoint
    this.app.get(metricsConfig.health_endpoint || '/health', (req, res) => {
      const health = this.getHealthStatus();
      const statusCode = health.healthy ? 200 : 503;
      res.status(statusCode).json(health);
    });

    // Metrics endpoint for Prometheus
    this.app.get(metricsConfig.endpoint || '/metrics', async (req, res) => {
      try {
        const metrics = await this.metrics.getMetrics();
        res.set('Content-Type', this.metrics.getContentType());
        res.send(metrics);
      } catch (error) {
        this.logger.error('Failed to get metrics', {
          error: error.message
        });
        res.status(500).json({ error: 'Failed to get metrics' });
      }
    });

    // Status endpoint
    this.app.get('/status', (req, res) => {
      const status = this.getStatus();
      res.json(status);
    });

    // Failover history endpoint
    this.app.get('/failover/history', (req, res) => {
      const history = this.failoverManager.getStatus();
      res.json(history);
    });

    // Manual failover endpoint (use with caution)
    this.app.post('/failover/manual', async (req, res) => {
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
    this.app.get('/sync/status', (req, res) => {
      const status = this.configSync.getSyncStatus();
      res.json(status);
    });

    // Trigger manual config sync
    this.app.post('/sync/trigger', async (req, res) => {
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
    this.app.get('/syslog/stats', (req, res) => {
      const stats = this.syslogListener.getStats();
      res.json(stats);
    });

    // Heartbeat status endpoint
    this.app.get('/heartbeat/status', (req, res) => {
      const status = this.heartbeatChecker.getStatus();
      res.json(status);
    });

    // Router configuration endpoint
    this.app.get('/config', (req, res) => {
      // Return sanitized config (no passwords)
      const sanitizedConfig = this.sanitizeConfig(this.config);
      res.json(sanitizedConfig);
    });

    // Reload configuration endpoint
    this.app.post('/config/reload', (req, res) => {
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

    // 404 handler
    this.app.use((req, res) => {
      res.status(404).json({
        error: 'Not Found',
        path: req.path
      });
    });

    // Error handler
    this.app.use((err, req, res, next) => {
      this.logger.error('Express error', {
        error: err.message,
        stack: err.stack,
        path: req.path
      });
      
      res.status(err.status || 500).json({
        error: err.message || 'Internal Server Error'
      });
    });
  }

  getHealthStatus() {
    const heartbeatStatus = this.heartbeatChecker.getStatus();
    const failoverStatus = this.failoverManager.getStatus();
    const syncStatus = this.configSync.getSyncStatus();
    
    const healthy = (
      (heartbeatStatus.primary.health === 'healthy' ||
       heartbeatStatus.backup.health === 'healthy') &&
      this.server !== null
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
    const port = this.config.metrics?.port || 9090;
    
    return new Promise((resolve, reject) => {
      this.server = this.app.listen(port, (err) => {
        if (err) {
          this.logger.error('Failed to start Express server', {
            error: err.message
          });
          reject(err);
        } else {
          this.logger.info('Express server started', {
            port,
            health: `http://localhost:${port}/health`,
            metrics: `http://localhost:${port}/metrics`,
            status: `http://localhost:${port}/status`
          });
          resolve();
        }
      });

      this.server.on('error', (err) => {
        this.logger.error('Express server error', {
          error: err.message
        });
      });
    });
  }

  stop() {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          this.logger.info('Express server stopped');
          resolve();
        });
      } else {
        resolve();
      }
    });
  }
}

module.exports = ExpressServer;