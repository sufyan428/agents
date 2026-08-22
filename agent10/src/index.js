#!/usr/bin/env node
require('dotenv').config();

const promClient = require('prom-client');
const { createServer, expensiveLimiterFor, installShutdown } = require('@ragent/agent-common');
const logger = require('./utils/logger');
const configLoader = require('./config/configLoader');
const { AiClient } = require('@ragent/ai-core');
const { ActionExecutor } = require('./services/actionExecutor');
const ChatEngine = require('./services/chatEngine');
const Notifier = require('./services/notifier');
const NotificationPoller = require('./services/notificationPoller');

class AIChatOpsAgent {
  constructor() {
    this.app = null;
    this.agentServer = null;
    this.config = null;
    this.chatEngine = null;
    this.notificationPoller = null;
  }

  async start() {
    this.config = configLoader.load();
    logger.info('Configuration loaded successfully');

    if (!this.config.ai) {
      throw new Error(
        `No AI provider configured. This agent is optional and does nothing without one.
  Set AI_API_KEY and AI_MODEL (or the legacy OPENROUTER_API_KEY / ANTHROPIC_API_KEY)
  in agent6/.env for the whole AI layer, or in this agent's own .env to run it alone.`,
      );
    }

    logger.info(
      `AI provider: ${this.config.ai.provider} | model: ${this.config.ai.model} | ` +
        `budget: ${this.config.ai.dailyCallBudget} calls/day`,
    );
    if (
      !this.config.notifications.slackWebhookUrl &&
      !this.config.notifications.discordWebhookUrl
    ) {
      logger.info(
        'No SLACK_WEBHOOK_URL/DISCORD_WEBHOOK_URL configured - proactive findings will be recorded locally only (GET /api/notifications)',
      );
    }

    const llmClient = new AiClient(this.config.ai, logger);
    this.llmClient = llmClient;

    // Probe once at startup. A wrong model name or an unreachable endpoint
    // should surface here with an actionable message, not thirty minutes later
    // as an unexplained null on the first real poll.
    this.probeResult = null;
    llmClient
      .probe()
      .then((p) => {
        this.probeResult = p;
        if (p.ok) logger.info(`AI provider reachable: ${p.detail}`);
        else
          logger.warn(`AI provider is NOT usable: ${p.detail}. This agent will produce no output.`);
      })
      .catch((e) => {
        this.probeResult = { ok: false, detail: e.message };
      });
    const actionExecutor = new ActionExecutor(this.config);
    this.chatEngine = new ChatEngine(this.config, llmClient, actionExecutor);
    const notifier = new Notifier(this.config);
    this.notificationPoller = new NotificationPoller(this.config, notifier);

    this.notificationPoller.start();

    const port = this.config.server.port;
    const host = process.env.BIND_HOST || this.config.server.host || '127.0.0.1';
    const token = (process.env.AGENT_API_TOKEN || '').trim() || undefined;

    this.agentServer = createServer({
      agent: 'agent10-chatops',
      logger,
      port,
      host,
      authToken: token,
      corsOrigins: (process.env.AGENT_CORS_ORIGINS || '')
        .split(',')
        .map((o) => o.trim())
        .filter(Boolean),
      // The routes on this agent call a paid or rate-limited model endpoint.
      // Without a tight cap, anyone who can reach the port can drain the
      // operator's API quota or bill.
      expensiveRateLimit: { windowMs: 60_000, max: 6 },
      healthChecks: () => {
        const s = this.llmClient ? this.llmClient.stats() : null;
        if (!s)
          return [
            {
              name: 'ai_provider',
              status: 'degraded',
              message: 'not initialised',
              simulated: false,
            },
          ];

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
        else if (exhausted)
          message = `daily budget exhausted (${s.budget.callsUsed}/${s.budget.callsLimit} calls)`;
        else if (broken) message = `circuit breaker ${s.breaker}: ${s.lastError ?? 'unknown'}`;

        return [
          {
            name: 'ai_provider',
            // Degraded, never unhealthy: the process is fine and the
            // deterministic agents are unaffected. Only this agent's output is
            // missing, and a supervisor must not restart it over that.
            status: message ? 'degraded' : 'healthy',
            message,
            simulated: false,
          },
        ];
      },
    });

    this.app = this.agentServer.app;
    this.setupMetrics();
    this.setupRoutes(this.app);
    await this.agentServer.listen();
  }

  setupMetrics() {
    this.register = this.agentServer.registry;

    this.gauges = {
      notificationsTotal: new promClient.Gauge({
        name: 'ai_chatops_notifications_total',
        help: 'Total proactive notifications recorded',
        registers: [this.register],
      }),
    };
  }

  setupRoutes(app) {
    // Tighter bucket for routes that hit the model endpoint.
    const expensive = expensiveLimiterFor(app);

    app.post('/api/chat', expensive, async (req, res) => {
      const { message } = req.body || {};
      if (!message || typeof message !== 'string') {
        return res.status(400).json({ success: false, error: '"message" (string) is required' });
      }
      try {
        const result = await this.chatEngine.processMessage(message);
        res.json({ success: true, ...result });
      } catch (error) {
        logger.error(`Chat processing failed: ${error.message}`);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    app.post('/api/chat/confirm', expensive, async (req, res) => {
      const { pendingAction } = req.body || {};
      if (!pendingAction) {
        return res.status(400).json({ success: false, error: '"pendingAction" is required' });
      }
      try {
        const result = await this.chatEngine.confirmAndExecute(pendingAction);
        res.json(result);
      } catch (error) {
        logger.error(`Confirmed action execution failed: ${error.message}`);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    app.get('/api/notifications', (req, res) => {
      res.json({ success: true, notifications: this.notificationPoller.getHistory() });
    });
  }

  stop() {
    if (this.notificationPoller) {
      this.notificationPoller.stop();
    }
    if (this.agentServer) {
      return this.agentServer.close();
    }
    return Promise.resolve();
  }
}

const agent = new AIChatOpsAgent();

installShutdown({
  logger,
  onShutdown: [() => agent.stop()],
});

agent.start().catch((error) => {
  logger.error(`Fatal error starting AI ChatOps Agent: ${error.message}`);
  process.exit(1);
});
