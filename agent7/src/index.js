#!/usr/bin/env node
require('dotenv').config();

const promClient = require('prom-client');
const { createServer, expensiveLimiterFor, installShutdown } = require('@ragent/agent-common');
const logger = require('./utils/logger');
const configLoader = require('./config/configLoader');
const { AiClient } = require('@ragent/ai-core');
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

    if (!this.config.ai) {
      throw new Error(
        `No AI provider configured. This agent is optional and does nothing without one.
  Set AI_API_KEY and AI_MODEL (or the legacy OPENROUTER_API_KEY / ANTHROPIC_API_KEY)
  in agent6/.env for the whole AI layer, or in this agent's own .env to run it alone.`
      );
    }

    logger.info(
      `AI provider: ${this.config.ai.provider} | model: ${this.config.ai.model} | ` +
      `budget: ${this.config.ai.dailyCallBudget} calls/day`
    );
    const llmClient = new AiClient(this.config.ai, logger);
    this.llmClient = llmClient;

    // Probe once at startup. A wrong model name or an unreachable endpoint
    // should surface here with an actionable message, not thirty minutes later
    // as an unexplained null on the first real poll.
    this.probeResult = null;
    llmClient.probe().then((p) => {
      this.probeResult = p;
      if (p.ok) logger.info(`AI provider reachable: ${p.detail}`);
      else logger.warn(`AI provider is NOT usable: ${p.detail}. This agent will produce no output.`);
    }).catch((e) => { this.probeResult = { ok: false, detail: e.message }; });
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
      healthChecks: () => {
        const s = this.llmClient ? this.llmClient.stats() : null;
        if (!s) return [{ name: 'ai_provider', status: 'degraded', message: 'not initialised', simulated: false }];

        const disabled = s.budget.callsLimit === 0;
        const exhausted = !disabled && s.budget.callsUsed >= s.budget.callsLimit;
        const broken = s.breaker !== 'closed';
        // A failed startup probe means the configured model is unusable. After
        // a single non-retryable failure the breaker is still closed, so
        // without this the agent reports healthy while producing nothing.
        const probeFailed = this.probeResult !== null && this.probeResult.ok === false;

        let message;
        if (probeFailed) message = `provider unusable: ${this.probeResult.detail}`;
        else if (disabled) message = 'AI disabled: daily call budget is 0';
        else if (exhausted) message = `daily budget exhausted (${s.budget.callsUsed}/${s.budget.callsLimit} calls)`;
        else if (broken) message = `circuit breaker ${s.breaker}: ${s.lastError ?? 'unknown'}`;

        return [{
          name: 'ai_provider',
          // Degraded, never unhealthy: the process is fine and the
          // deterministic agents are unaffected. Only this agent's output is
          // missing, and a supervisor must not restart it over that.
          status: message ? 'degraded' : 'healthy',
          message,
          simulated: false,
        }];
      }
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
