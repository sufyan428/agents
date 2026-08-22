#!/usr/bin/env node
require('dotenv').config();

const express = require('express');
const promClient = require('prom-client');
const logger = require('./utils/logger');
const configLoader = require('./config/configLoader');
const createLlmClient = require('./services/llmClientFactory');
const DataCollector = require('./services/dataCollector');
const RemediationAdvisor = require('./services/remediationAdvisor');
const SuggestionPoller = require('./services/suggestionPoller');

class AIRemediationAgent {
  constructor() {
    this.app = express();
    this.config = null;
    this.advisor = null;
    this.poller = null;
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
    this.advisor = new RemediationAdvisor(this.config, llmClient, dataCollector);
    this.poller = new SuggestionPoller(this.config, this.advisor);

    this.setupMetrics();
    this.setupRoutes();

    this.poller.start();

    const port = this.config.server.port;
    return new Promise((resolve, reject) => {
      this.server = this.app.listen(port, '0.0.0.0', () => {
        logger.info(`AI Remediation Agent listening on port ${port}`);
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
      suggestionsTotal: new promClient.Gauge({
        name: 'ai_remediation_suggestions_total',
        help: 'Total suggestions/runbooks/reviews recorded',
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
        aiEnabled: true,
        autoApply: false
      });
    });

    this.app.get(this.config.server.metrics_path, async (req, res) => {
      this.gauges.suggestionsTotal.set(this.advisor.getHistory().length);
      res.set('Content-Type', this.register.contentType);
      res.send(await this.register.metrics());
    });

    this.app.get('/api/suggestions', (req, res) => {
      res.json({ success: true, history: this.advisor.getHistory() });
    });

    this.app.get('/api/suggestions/latest', (req, res) => {
      const latest = this.advisor.getLatest();
      if (!latest) {
        return res.status(404).json({ success: false, error: 'No suggestions recorded yet' });
      }
      res.json({ success: true, suggestion: latest });
    });

    this.app.post('/api/suggestions/generate', async (req, res) => {
      try {
        const result = await this.advisor.suggestRemediation();
        if (!result) {
          return res.status(502).json({ success: false, error: 'Suggestion generation returned no content' });
        }
        res.json({ success: true, result });
      } catch (error) {
        logger.error(`On-demand suggestion generation failed: ${error.message}`);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    this.app.post('/api/runbook', async (req, res) => {
      try {
        const { incidentDescription } = req.body || {};
        const result = await this.advisor.generateRunbook(incidentDescription);
        if (!result) {
          return res.status(400).json({
            success: false,
            error: 'No incident description provided and no recent agent7 incident was found to generate a runbook from'
          });
        }
        res.json({ success: true, result });
      } catch (error) {
        logger.error(`Runbook generation failed: ${error.message}`);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    this.app.post('/api/review', async (req, res) => {
      const { proposedChange } = req.body || {};
      if (!proposedChange) {
        return res.status(400).json({ success: false, error: '"proposedChange" is required in the request body' });
      }
      try {
        const result = await this.advisor.reviewConfigChange(proposedChange);
        if (!result) {
          return res.status(502).json({ success: false, error: 'Review returned no content' });
        }
        res.json({ success: true, result });
      } catch (error) {
        logger.error(`Config change review failed: ${error.message}`);
        res.status(500).json({ success: false, error: error.message });
      }
    });
  }

  stop() {
    if (this.poller) {
      this.poller.stop();
    }
    if (this.server) {
      this.server.close();
    }
  }
}

const agent = new AIRemediationAgent();

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
  logger.error(`Fatal error starting AI Remediation Agent: ${error.message}`);
  process.exit(1);
});
