const express = require('express');
const cors = require('cors');
const logger = require('./utils/logger');
const agentManager = require('./agent-manager');
const configManager = require('./config-manager');

class APIGateway {
    constructor() {
        this.app = express();
        this.setupMiddleware();
        this.setupRoutes();
    }

    setupMiddleware() {
        this.app.use(cors());
        this.app.use(express.json());

        // Request logging
        this.app.use((req, res, next) => {
            logger.debug(`${req.method} ${req.path}`);
            next();
        });
    }

    setupRoutes() {
        // Health check
        this.app.get('/health', (req, res) => {
            res.json({
                healthy: true,
                service: 'orchestrator',
                timestamp: new Date().toISOString(),
                uptime: process.uptime()
            });
        });

        // Get all agents status
        this.app.get('/api/agents', (req, res) => {
            try {
                const status = agentManager.getAllAgentsStatus();
                res.json({
                    success: true,
                    agents: status
                });
            } catch (error) {
                logger.error(`Failed to get agents status: ${error.message}`);
                res.status(500).json({
                    success: false,
                    error: error.message
                });
            }
        });

        // Get specific agent status
        this.app.get('/api/agents/:name', (req, res) => {
            try {
                const { name } = req.params;
                const allStatus = agentManager.getAllAgentsStatus();

                if (!allStatus[name]) {
                    return res.status(404).json({
                        success: false,
                        error: 'Agent not found'
                    });
                }

                res.json({
                    success: true,
                    agent: allStatus[name]
                });
            } catch (error) {
                logger.error(`Failed to get agent status: ${error.message}`);
                res.status(500).json({
                    success: false,
                    error: error.message
                });
            }
        });

        // Start specific agent
        this.app.post('/api/agents/:name/start', (req, res) => {
            try {
                const { name } = req.params;
                const result = agentManager.startAgent(name);

                res.json({
                    success: result,
                    message: result ? `Agent ${name} started` : `Agent ${name} already running or disabled`
                });
            } catch (error) {
                logger.error(`Failed to start agent: ${error.message}`);
                res.status(500).json({
                    success: false,
                    error: error.message
                });
            }
        });

        // Stop specific agent
        this.app.post('/api/agents/:name/stop', (req, res) => {
            try {
                const { name } = req.params;
                const result = agentManager.stopAgent(name);

                res.json({
                    success: result,
                    message: result ? `Agent ${name} stopped` : `Agent ${name} already stopped`
                });
            } catch (error) {
                logger.error(`Failed to stop agent: ${error.message}`);
                res.status(500).json({
                    success: false,
                    error: error.message
                });
            }
        });

        // Restart specific agent
        this.app.post('/api/agents/:name/restart', async (req, res) => {
            try {
                const { name } = req.params;
                await agentManager.restartAgent(name);

                res.json({
                    success: true,
                    message: `Agent ${name} restarted`
                });
            } catch (error) {
                logger.error(`Failed to restart agent: ${error.message}`);
                res.status(500).json({
                    success: false,
                    error: error.message
                });
            }
        });

        // Start all agents
        this.app.post('/api/agents/start-all', (req, res) => {
            try {
                const count = agentManager.startAllAgents();

                res.json({
                    success: true,
                    message: `Started ${count} agents`
                });
            } catch (error) {
                logger.error(`Failed to start all agents: ${error.message}`);
                res.status(500).json({
                    success: false,
                    error: error.message
                });
            }
        });

        // Stop all agents
        this.app.post('/api/agents/stop-all', (req, res) => {
            try {
                const count = agentManager.stopAllAgents();

                res.json({
                    success: true,
                    message: `Stopped ${count} agents`
                });
            } catch (error) {
                logger.error(`Failed to stop all agents: ${error.message}`);
                res.status(500).json({
                    success: false,
                    error: error.message
                });
            }
        });

        // Check health of all agents
        this.app.get('/api/health/agents', async (req, res) => {
            try {
                const health = await agentManager.checkAllAgentsHealth();

                res.json({
                    success: true,
                    health
                });
            } catch (error) {
                logger.error(`Failed to check agents health: ${error.message}`);
                res.status(500).json({
                    success: false,
                    error: error.message
                });
            }
        });

        // Check health of specific agent
        this.app.get('/api/health/agents/:name', async (req, res) => {
            try {
                const { name } = req.params;
                const health = await agentManager.checkAgentHealth(name);

                res.json({
                    success: true,
                    health
                });
            } catch (error) {
                logger.error(`Failed to check agent health: ${error.message}`);
                res.status(500).json({
                    success: false,
                    error: error.message
                });
            }
        });

        // Get current configuration
        this.app.get('/api/config', (req, res) => {
            try {
                const config = configManager.loadMasterConfig();

                // Sanitize sensitive data
                const sanitized = JSON.parse(JSON.stringify(config));
                if (sanitized.router?.primary?.snmp_community) {
                    sanitized.router.primary.snmp_community = '***';
                }
                if (sanitized.router?.backup?.snmp_community) {
                    sanitized.router.backup.snmp_community = '***';
                }

                res.json({
                    success: true,
                    config: sanitized
                });
            } catch (error) {
                logger.error(`Failed to get configuration: ${error.message}`);
                res.status(500).json({
                    success: false,
                    error: error.message
                });
            }
        });

        // Reload and distribute configuration
        this.app.post('/api/config/reload', (req, res) => {
            try {
                configManager.loadMasterConfig();
                configManager.distributeConfigs();

                res.json({
                    success: true,
                    message: 'Configuration reloaded and distributed to all agents'
                });
            } catch (error) {
                logger.error(`Failed to reload configuration: ${error.message}`);
                res.status(500).json({
                    success: false,
                    error: error.message
                });
            }
        });

        // System overview
        this.app.get('/api/overview', async (req, res) => {
            try {
                const agentsStatus = agentManager.getAllAgentsStatus();
                const health = await agentManager.checkAllAgentsHealth();

                const overview = {
                    totalAgents: Object.keys(agentsStatus).length,
                    runningAgents: Object.values(agentsStatus).filter(a => a.status === 'running').length,
                    healthyAgents: Object.values(health).filter(h => h.healthy).length,
                    agents: {}
                };

                for (const [name, status] of Object.entries(agentsStatus)) {
                    overview.agents[name] = {
                        ...status,
                        healthy: health[name]?.healthy || false
                    };
                }

                res.json({
                    success: true,
                    overview
                });
            } catch (error) {
                logger.error(`Failed to get overview: ${error.message}`);
                res.status(500).json({
                    success: false,
                    error: error.message
                });
            }
        });

        // Error handler
        this.app.use((err, req, res, next) => {
            logger.error(`Unhandled error: ${err.message}`);
            res.status(500).json({
                success: false,
                error: 'Internal server error'
            });
        });
    }

    start(port) {
        return new Promise((resolve, reject) => {
            try {
                this.server = this.app.listen(port, () => {
                    logger.info(`API Gateway listening on port ${port}`);
                    resolve();
                });
            } catch (error) {
                reject(error);
            }
        });
    }

    stop() {
        return new Promise((resolve) => {
            if (this.server) {
                this.server.close(() => {
                    logger.info('API Gateway stopped');
                    resolve();
                });
            } else {
                resolve();
            }
        });
    }
}

module.exports = new APIGateway();
