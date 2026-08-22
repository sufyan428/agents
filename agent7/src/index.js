#!/usr/bin/env node
require('dotenv').config();

const express = require('express');
const promClient = require('prom-client');
const logger = require('./utils/logger');
const configLoader = require('./config/configLoader');
const createLlmClient = require('./services/llmClientFactory');
const CorrelationEngine = require('./services/correlationEngine');

class AICorrelationAgent {
  constructor() {
    this.app = express();
    this.config = null;
    this.correlationEngine = null;
    this.server = null;
  }

  async start() {
    this.config = configLoader.load();
    logger.info('Configuration loaded successfully');

    if (!this.config.ai.apiKey) {
      throw new Error(
        'No AI provider configured. Set OPENROUTER_API_KEY (free by default) or ' +
          'ANTHROPIC_API_KEY in .env before starting this agent - see .env.example.'
      );
    }

    logger.info(`AI provider: ${this.config.ai.provider} (model: ${this.config.ai.model})`);
    const llmClient = createLlmClient(this.config);
    this.correlationEngine = new CorrelationEngine(this.config, llmClient);

    this.setupMetrics();
    this.setupRoutes();

    this.correlationEngine.start();

    const port = this.config.server.port;
    return new Promise((resolve, reject) => {
      this.server = this.app.listen(port, '0.0.0.0', () => {
        logger.info(`AI Correlation Agent listening on port ${port}`);
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
      pollsTotal: new promClient.Gauge({
        name: 'ai_correlation_polls_total',
        help: 'Total collector polls run',
        registers: [this.register]
      }),
      llmCallsTotal: new promClient.Gauge({
        name: 'ai_correlation_llm_calls_total',
        help: 'Total Claude API calls made',
        registers: [this.register]
      }),
      llmErrorsTotal: new promClient.Gauge({
        name: 'ai_correlation_llm_errors_total',
        help: 'Total Claude API call failures',
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
      const metrics = this.correlationEngine.getMetrics();
      this.gauges.pollsTotal.set(metrics.pollsTotal);
      this.gauges.llmCallsTotal.set(metrics.llmCallsTotal);
      this.gauges.llmErrorsTotal.set(metrics.llmErrorsTotal);

      res.set('Content-Type', this.register.contentType);
      res.send(await this.register.metrics());
    });

    this.app.get('/api/snapshot', (req, res) => {
      res.json({
        success: true,
        snapshot: this.correlationEngine.getLatestSnapshot()
      });
    });

    this.app.get('/api/incidents', (req, res) => {
      res.json({
        success: true,
        latest: this.correlationEngine.getLatestResult(),
        metrics: this.correlationEngine.getMetrics()
      });
    });

    this.app.post('/api/ask', async (req, res) => {
      const { question } = req.body;
      if (!question || typeof question !== 'string') {
        return res.status(400).json({ success: false, error: '"question" (string) is required' });
      }

      try {
        const result = await this.correlationEngine.askQuestion(question);
        if (!result || !result.text) {
          return res.status(502).json({ success: false, error: 'Claude did not return an answer' });
        }
        res.json({ success: true, answer: result.text, usage: result.usage });
      } catch (error) {
        logger.error(`Failed to answer question: ${error.message}`);
        res.status(500).json({ success: false, error: error.message });
      }
    });
  }

  stop() {
    if (this.correlationEngine) {
      this.correlationEngine.stop();
    }
    if (this.server) {
      this.server.close();
    }
  }
}

const agent = new AICorrelationAgent();

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
  logger.error(`Fatal error starting AI Correlation Agent: ${error.message}`);
  process.exit(1);
});
