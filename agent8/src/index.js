#!/usr/bin/env node
require('dotenv').config();

const express = require('express');
const promClient = require('prom-client');
const logger = require('./utils/logger');
const configLoader = require('./config/configLoader');
const createLlmClient = require('./services/llmClientFactory');
const DataCollector = require('./services/dataCollector');
const ReportGenerator = require('./services/reportGenerator');
const ReportScheduler = require('./services/reportScheduler');

class AIReportingAgent {
  constructor() {
    this.app = express();
    this.config = null;
    this.reportGenerator = null;
    this.scheduler = null;
    this.server = null;
  }

  async start() {
    this.config = configLoader.load();
    logger.info('Configuration loaded successfully');

    if (!this.config.ai.apiKey) {
      throw new Error(
        'No AI provider configured. Set OPENROUTER_API_KEY (free by default) or ' +
          'ANTHROPIC_API_KEY in agent6/.env (shared) or this agent\'s own .env before starting.'
      );
    }

    logger.info(`AI provider: ${this.config.ai.provider} (model: ${this.config.ai.model})`);
    const llmClient = createLlmClient(this.config);
    const dataCollector = new DataCollector(this.config);
    this.reportGenerator = new ReportGenerator(this.config, llmClient, dataCollector);
    this.scheduler = new ReportScheduler(this.config, this.reportGenerator);

    this.setupMetrics();
    this.setupRoutes();

    this.scheduler.start();

    const port = this.config.server.port;
    return new Promise((resolve, reject) => {
      this.server = this.app.listen(port, '0.0.0.0', () => {
        logger.info(`AI Reporting Agent listening on port ${port}`);
        logger.info(`Health check: http://localhost:${port}${this.config.server.health_path}`);
        resolve();
      });
      this.server.on('error', reject);
    });
  }

  setupMetrics() {
    this.register = new promClient.Registry();
    promClient.collectDefaultMetrics({ register: this.register });

    this.gauges = {
      reportsGenerated: new promClient.Gauge({
        name: 'ai_reporting_reports_generated_total',
        help: 'Total reports generated',
        registers: [this.register]
      })
    };
  }

  setupRoutes() {
    this.app.use(express.json());

    this.app.get(this.config.server.health_path, (req, res) => {
      res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        aiEnabled: true
      });
    });

    this.app.get(this.config.server.metrics_path, async (req, res) => {
      this.gauges.reportsGenerated.set(this.reportGenerator.getHistory().length);
      res.set('Content-Type', this.register.contentType);
      res.send(await this.register.metrics());
    });

    this.app.get('/api/reports', (req, res) => {
      res.json({ success: true, reports: this.reportGenerator.getHistory() });
    });

    this.app.get('/api/reports/latest', (req, res) => {
      const latest = this.reportGenerator.getLatest();
      if (!latest) {
        return res.status(404).json({ success: false, error: 'No reports generated yet' });
      }
      res.json({ success: true, report: latest });
    });

    this.app.get('/api/reports/:id', (req, res) => {
      const report = this.reportGenerator.getById(req.params.id);
      if (!report) {
        return res.status(404).json({ success: false, error: 'Report not found' });
      }
      res.json({ success: true, report });
    });

    this.app.post('/api/reports/generate', async (req, res) => {
      try {
        const report = await this.reportGenerator.generate('on-demand');
        if (!report) {
          return res.status(502).json({ success: false, error: 'Report generation returned no content' });
        }
        res.json({ success: true, report });
      } catch (error) {
        logger.error(`On-demand report generation failed: ${error.message}`);
        res.status(500).json({ success: false, error: error.message });
      }
    });
  }

  stop() {
    if (this.scheduler) {
      this.scheduler.stop();
    }
    if (this.server) {
      this.server.close();
    }
  }
}

const agent = new AIReportingAgent();

process.on('SIGTERM', () => {
  logger.info('Received SIGTERM, shutting down');
  agent.stop();
  process.exit(0);
});

process.on('SIGINT', () => {
  logger.info('Received SIGINT, shutting down');
  agent.stop();
  process.exit(0);
});

process.on('uncaughtException', (error) => {
  logger.error(`Uncaught exception: ${error.message}`);
  logger.error(error.stack);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error(`Unhandled rejection: ${reason}`);
  process.exit(1);
});

agent.start().catch((error) => {
  logger.error(`Fatal error starting AI Reporting Agent: ${error.message}`);
  process.exit(1);
});
