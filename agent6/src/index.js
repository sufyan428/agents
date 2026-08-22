#!/usr/bin/env node
require('dotenv').config();

const logger = require('./utils/logger');
const configManager = require('./config-manager');
const agentManager = require('./agent-manager');
const apiGateway = require('./api-gateway');
const correlationEngine = require('./correlation');

class Orchestrator {
  constructor() {
    this.running = false;
  }

  async start() {
    try {
      logger.info('='.repeat(60));
      logger.info('Router Framework Orchestrator - Starting');
      logger.info('='.repeat(60));

      // Load master configuration
      logger.info('Loading master configuration...');
      const masterConfig = configManager.loadMasterConfig();

      // Distribute configurations to all agents
      logger.info('Distributing configurations to agents...');
      configManager.distributeConfigs();

      // Initialize agent manager
      logger.info('Initializing agent manager...');
      await agentManager.initializeAgents(masterConfig.agents);

      // Start API Gateway
      const apiPort = masterConfig.orchestrator.api_port;
      // Loopback unless deliberately overridden. The gateway can stop
      // every agent in the framework, so it does not get exposed to the
      // network by default.
      const apiHost = process.env.BIND_HOST || masterConfig.orchestrator.bind_host || '127.0.0.1';
      logger.info(`Starting API Gateway on ${apiHost}:${apiPort}...`);
      await apiGateway.start(apiPort, apiHost);

      // Start all enabled agents
      logger.info('Starting all enabled agents...');
      agentManager.startAllAgents();

      // Start health monitoring
      const healthInterval = masterConfig.orchestrator.health_check_interval * 1000;
      logger.info(`Starting health monitoring (interval: ${healthInterval}ms)...`);
      agentManager.startHealthMonitoring(healthInterval);

      // Deterministic correlation across every agent's findings. Runs
      // whether or not the AI layer is configured.
      correlationEngine.start();

      this.running = true;

      logger.info('='.repeat(60));
      logger.info('Router Framework Orchestrator - Started Successfully');
      logger.info('='.repeat(60));
      logger.info(`API Gateway: http://${apiHost}:${apiPort}`);
      logger.info(`Health Check: http://${apiHost}:${apiPort}/health`);
      logger.info(`System Overview: http://${apiHost}:${apiPort}/api/overview`);
      logger.info(`Incidents:       http://${apiHost}:${apiPort}/api/incidents`);
      logger.info('='.repeat(60));
    } catch (error) {
      logger.error(`Failed to start orchestrator: ${error.message}`);
      logger.error(error.stack);
      process.exit(1);
    }
  }

  async stop() {
    if (!this.running) {
      return;
    }

    logger.info('Shutting down orchestrator...');

    try {
      // Stop health monitoring
      agentManager.stopHealthMonitoring();
      correlationEngine.stop();

      // Stop all agents
      logger.info('Stopping all agents...');
      agentManager.stopAllAgents();

      // Stop API Gateway
      logger.info('Stopping API Gateway...');
      await apiGateway.stop();

      this.running = false;
      logger.info('Orchestrator stopped successfully');
    } catch (error) {
      logger.error(`Error during shutdown: ${error.message}`);
    }
  }
}

// Create orchestrator instance
const orchestrator = new Orchestrator();

// Handle graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('Received SIGTERM signal');
  await orchestrator.stop();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('Received SIGINT signal');
  await orchestrator.stop();
  process.exit(0);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  logger.error(`Uncaught exception: ${error.message}`);
  logger.error(error.stack);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error(`Unhandled rejection at: ${promise}, reason: ${reason}`);
  process.exit(1);
});

// Start orchestrator
orchestrator.start().catch((error) => {
  logger.error(`Fatal error: ${error.message}`);
  process.exit(1);
});
