#!/usr/bin/env node
require('dotenv').config();

const promClient = require('prom-client');
const { createServer, expensiveLimiterFor, installShutdown } = require('@ragent/agent-common');
const logger = require('./utils/logger');
const configLoader = require('./config/configLoader');
const createLlmClient = require('./services/llmClientFactory');
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

    if (!this.config.ai.apiKey) {
      throw new Error(
        'No AI provider configured. Set OPENROUTER_API_KEY (free by default) or ' +
          'ANTHROPIC_API_KEY in agent6/.env (shared) or this agent\'s own .env before starting.'
      );
    }

    logger.info(`AI provider: ${this.config.ai.provider} (model: ${this.config.ai.model})`);
    if (!this.config.notifications.slackWebhookUrl && !this.config.notifications.discordWebhookUrl) {
      logger.info('No SLACK_WEBHOOK_URL/DISCORD_WEBHOOK_URL configured - proactive findings will be recorded locally only (GET /api/notifications)');
    }

    const llmClient = createLlmClient(this.config);
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
      notificationsTotal: new promClient.Gauge({
        name: 'ai_chatops_notifications_total',
        help: 'Total proactive notifications recorded',
        registers: [this.register]
      })
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
  onShutdown: [() => agent.stop()]
});

agent.start().catch((error) => {
  logger.error(`Fatal error starting AI ChatOps Agent: ${error.message}`);
  process.exit(1);
});
