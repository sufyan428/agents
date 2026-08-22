#!/usr/bin/env node
require('dotenv').config();

const promClient = require('prom-client');
const { createServer, expensiveLimiterFor, installShutdown } = require('@ragent/agent-common');
const logger = require('./utils/logger');
const configLoader = require('./config/configLoader');
const createLlmClient = require('./services/llmClientFactory');
const CorrelationEngine = require('./services/correlationEngine');

class AICorrelationAgent {
  constructor() {
    this.app = null;
    this.agentServer = null;
    this.config = null;
    this.correlationEngine = null;
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

    this.correlationEngine.start();

    const port = this.config.server.port;
    const host = process.env.BIND_HOST || this.config.server.host || '127.0.0.1';
    const token = (process.env.AGENT_API_TOKEN || '').trim() || undefined;

    this.agentServer = createServer({
      agent: 'agent7-correlation',
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

  setupRoutes(app) {
    // Tighter bucket for routes that hit the model endpoint.
    const expensive = expensiveLimiterFor(app);

    app.get('/api/snapshot', (req, res) => {
      res.json({
        success: true,
        snapshot: this.correlationEngine.getLatestSnapshot()
      });
    });

    app.get('/api/incidents', (req, res) => {
      res.json({
        success: true,
        latest: this.correlationEngine.getLatestResult(),
        metrics: this.correlationEngine.getMetrics()
      });
    });

    app.post('/api/ask', expensive, async (req, res) => {
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
    if (this.agentServer) {
      return this.agentServer.close();
    }
    return Promise.resolve();
  }
}

const agent = new AICorrelationAgent();

installShutdown({
  logger,
  onShutdown: [() => agent.stop()]
});

agent.start().catch((error) => {
  logger.error(`Fatal error starting AI Correlation Agent: ${error.message}`);
  process.exit(1);
});
