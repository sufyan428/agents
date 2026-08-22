#!/usr/bin/env node
require('dotenv').config();

const express = require('express');
const promClient = require('prom-client');
const logger = require('./utils/logger');
const configLoader = require('./config/configLoader');
const createLlmClient = require('./services/llmClientFactory');
const { ActionExecutor } = require('./services/actionExecutor');
const ChatEngine = require('./services/chatEngine');
const Notifier = require('./services/notifier');
const NotificationPoller = require('./services/notificationPoller');

class AIChatOpsAgent {
  constructor() {
    this.app = express();
    this.config = null;
    this.chatEngine = null;
    this.notificationPoller = null;
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
    if (!this.config.notifications.slackWebhookUrl && !this.config.notifications.discordWebhookUrl) {
      logger.info('No SLACK_WEBHOOK_URL/DISCORD_WEBHOOK_URL configured - proactive findings will be recorded locally only (GET /api/notifications)');
    }

    const llmClient = createLlmClient(this.config);
    const actionExecutor = new ActionExecutor(this.config);
    this.chatEngine = new ChatEngine(this.config, llmClient, actionExecutor);
    const notifier = new Notifier(this.config);
    this.notificationPoller = new NotificationPoller(this.config, notifier);

    this.setupMetrics();
    this.setupRoutes();

    this.notificationPoller.start();

    const port = this.config.server.port;
    return new Promise((resolve, reject) => {
      this.server = this.app.listen(port, '0.0.0.0', () => {
        logger.info(`AI ChatOps Agent listening on port ${port}`);
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
      notificationsTotal: new promClient.Gauge({
        name: 'ai_chatops_notifications_total',
        help: 'Total proactive notifications recorded',
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
      this.gauges.notificationsTotal.set(this.notificationPoller.getHistory().length);
      res.set('Content-Type', this.register.contentType);
      res.send(await this.register.metrics());
    });

    this.app.post('/api/chat', async (req, res) => {
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

    this.app.post('/api/chat/confirm', async (req, res) => {
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

    this.app.get('/api/notifications', (req, res) => {
      res.json({ success: true, notifications: this.notificationPoller.getHistory() });
    });
  }

  stop() {
    if (this.notificationPoller) {
      this.notificationPoller.stop();
    }
    if (this.server) {
      this.server.close();
    }
  }
}

const agent = new AIChatOpsAgent();

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
  logger.error(`Fatal error starting AI ChatOps Agent: ${error.message}`);
  process.exit(1);
});
