#!/usr/bin/env node
require('dotenv').config();

const promClient = require('prom-client');
const { createServer, expensiveLimiterFor, installShutdown } = require('@ragent/agent-common');
const logger = require('./utils/logger');
const configLoader = require('./config/configLoader');
const createLlmClient = require('./services/llmClientFactory');
const DataCollector = require('./services/dataCollector');
const RemediationAdvisor = require('./services/remediationAdvisor');
const SuggestionPoller = require('./services/suggestionPoller');

class AIRemediationAgent {
  constructor() {
    this.app = null;
    this.agentServer = null;
    this.config = null;
    this.advisor = null;
    this.poller = null;
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

    this.poller.start();

    const port = this.config.server.port;
    const host = process.env.BIND_HOST || this.config.server.host || '127.0.0.1';
    const token = (process.env.AGENT_API_TOKEN || '').trim() || undefined;

    this.agentServer = createServer({
      agent: 'agent9-remediation',
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
      suggestionsTotal: new promClient.Gauge({
        name: 'ai_remediation_suggestions_total',
        help: 'Total suggestions/runbooks/reviews recorded',
        registers: [this.register]
      })
    };
  }

  setupRoutes(app) {
    // Tighter bucket for routes that hit the model endpoint.
    const expensive = expensiveLimiterFor(app);

    app.get('/api/suggestions', (req, res) => {
      res.json({ success: true, history: this.advisor.getHistory() });
    });

    app.get('/api/suggestions/latest', (req, res) => {
      const latest = this.advisor.getLatest();
      if (!latest) {
        return res.status(404).json({ success: false, error: 'No suggestions recorded yet' });
      }
      res.json({ success: true, suggestion: latest });
    });

    app.post('/api/suggestions/generate', expensive, async (req, res) => {
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

    app.post('/api/runbook', expensive, async (req, res) => {
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

    app.post('/api/review', expensive, async (req, res) => {
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
    if (this.agentServer) {
      return this.agentServer.close();
    }
    return Promise.resolve();
  }
}

const agent = new AIRemediationAgent();

installShutdown({
  logger,
  onShutdown: [() => agent.stop()]
});

agent.start().catch((error) => {
  logger.error(`Fatal error starting AI Remediation Agent: ${error.message}`);
  process.exit(1);
});
