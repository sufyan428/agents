#!/usr/bin/env node
require('dotenv').config();

const promClient = require('prom-client');
const { createServer, expensiveLimiterFor, installShutdown } = require('@ragent/agent-common');
const logger = require('./utils/logger');
const configLoader = require('./config/configLoader');
const createLlmClient = require('./services/llmClientFactory');
const DataCollector = require('./services/dataCollector');
const ReportGenerator = require('./services/reportGenerator');
const ReportScheduler = require('./services/reportScheduler');

class AIReportingAgent {
  constructor() {
    this.app = null;
    this.agentServer = null;
    this.config = null;
    this.reportGenerator = null;
    this.scheduler = null;
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

    this.scheduler.start();

    const port = this.config.server.port;
    const host = process.env.BIND_HOST || this.config.server.host || '127.0.0.1';
    const token = (process.env.AGENT_API_TOKEN || '').trim() || undefined;

    this.agentServer = createServer({
      agent: 'agent8-reporting',
      logger,
      port,
      host,
      authToken: token,
      corsOrigins: (process.env.AGENT_CORS_ORIGINS || '').split(',').map((o) => o.trim()).filter(Boolean),
      // The routes on this agent call a paid or rate-limited model endpoint.
      // Without a tight cap, anyone who can reach the port can drain the
      // operator's API quota or bill.
      expensiveRateLimit: { windowMs: 60_000, max: 6 },
      healthChecks: () => [
        { name: 'ai_provider', status: 'healthy', message: undefined, simulated: false }
      ]
    });

    this.app = this.agentServer.app;
    this.setupMetrics();
    this.setupRoutes(this.app);
    await this.agentServer.listen();
  }

  setupMetrics() {
    this.register = this.agentServer.registry;

    this.gauges = {
      reportsGenerated: new promClient.Gauge({
        name: 'ai_reporting_reports_generated_total',
        help: 'Total reports generated',
        registers: [this.register]
      })
    };
  }

  setupRoutes(app) {
    // Tighter bucket for routes that hit the model endpoint.
    const expensive = expensiveLimiterFor(app);

    app.get('/api/reports', (req, res) => {
      res.json({ success: true, reports: this.reportGenerator.getHistory() });
    });

    app.get('/api/reports/latest', (req, res) => {
      const latest = this.reportGenerator.getLatest();
      if (!latest) {
        return res.status(404).json({ success: false, error: 'No reports generated yet' });
      }
      res.json({ success: true, report: latest });
    });

    app.get('/api/reports/:id', (req, res) => {
      const report = this.reportGenerator.getById(req.params.id);
      if (!report) {
        return res.status(404).json({ success: false, error: 'Report not found' });
      }
      res.json({ success: true, report });
    });

    app.post('/api/reports/generate', expensive, async (req, res) => {
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
    if (this.agentServer) {
      return this.agentServer.close();
    }
    return Promise.resolve();
  }
}

const agent = new AIReportingAgent();

installShutdown({
  logger,
  onShutdown: [() => agent.stop()]
});

agent.start().catch((error) => {
  logger.error(`Fatal error starting AI Reporting Agent: ${error.message}`);
  process.exit(1);
});
