const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const logger = require('./utils/logger');

class AgentManager {
    constructor() {
        this.agents = new Map();
        this.agentsDir = path.join(__dirname, '..', '..');
        this.healthCheckInterval = null;
    }

    /**
     * AI agents (7+) are BYOK - only worth attempting if a key is actually
     * configured. Checked here (rather than relying solely on the agent's own
     * fail-fast) so the status list clearly shows "disabled: no API key"
     * instead of endlessly retrying and giving up. Two places a key can live:
     * the orchestrator's own .env (the single shared file for all AI agents -
     * already loaded into this process's env, and spread into every spawned
     * child below), or that agent's own local .env (standalone-run fallback).
     */
    hasApiKey(agentDirName, envVarNames) {
        if (envVarNames.some((name) => process.env[name] && process.env[name].trim().length > 0)) {
            return true;
        }

        const envPath = path.join(this.agentsDir, agentDirName, '.env');
        if (!fs.existsSync(envPath)) return false;
        const contents = fs.readFileSync(envPath, 'utf8');
        return envVarNames.some((name) => {
            const match = contents.match(new RegExp(`^${name}=(.+)$`, 'm'));
            return match && match[1].trim().length > 0;
        });
    }

    /**
     * Adds an AI agent's definition to the roster only if its router.yml entry
     * is enabled AND a key is actually configured; otherwise logs why it was
     * skipped so the user knows exactly what to do.
     */
    pushAiAgentIfKeyed(agentDefinitions, agentConfig, dirName, name) {
        if (!agentConfig || !agentConfig.enabled) return;

        if (this.hasApiKey(dirName, ['OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY'])) {
            agentDefinitions.push({
                name,
                enabled: true,
                port: agentConfig.port,
                path: path.join(this.agentsDir, dirName),
                startCommand: 'npm',
                startArgs: ['start'],
                healthEndpoint: `/health`
            });
        } else {
            logger.info(
                `${name} disabled: no OPENROUTER_API_KEY or ANTHROPIC_API_KEY found ` +
                    `(paste one into agent6/.env, or ${dirName}/.env for a standalone run, to enable it)`
            );
        }
    }

    /**
     * Initialize all agents based on configuration
     */
    async initializeAgents(agentConfigs) {
        const agentDefinitions = [
            {
                name: 'agent1-monitoring',
                enabled: agentConfigs.monitoring.enabled,
                port: agentConfigs.monitoring.port,
                path: path.join(this.agentsDir, 'agent1'),
                startCommand: 'npm',
                startArgs: ['start'],
                healthEndpoint: `/health`
            },
            {
                name: 'agent2-resilience',
                enabled: agentConfigs.resilience.enabled,
                port: agentConfigs.resilience.port,
                path: path.join(this.agentsDir, 'agent2'),
                startCommand: 'npm',
                startArgs: ['start'],
                healthEndpoint: `/health`
            },
            {
                name: 'agent3-security',
                enabled: agentConfigs.security.enabled,
                port: agentConfigs.security.port,
                path: path.join(this.agentsDir, 'agent3'),
                startCommand: 'npm',
                startArgs: ['start'],
                healthEndpoint: `/health`
            },
            {
                name: 'agent4-performance',
                enabled: agentConfigs.performance.enabled,
                port: agentConfigs.performance.port,
                path: path.join(this.agentsDir, 'agent4'),
                startCommand: 'npm',
                startArgs: ['start'],
                healthEndpoint: `/health`
            },
            {
                name: 'agent5-automation',
                enabled: agentConfigs.automation.enabled,
                port: agentConfigs.automation.port,
                path: path.join(this.agentsDir, 'agent5'),
                startCommand: 'npm',
                startArgs: ['start'],
                healthEndpoint: `/health`
            }
        ];

        // AI agents (7+) are BYOK - each only gets added to the roster if
        // enabled in router.yml AND a key is actually configured.
        this.pushAiAgentIfKeyed(agentDefinitions, agentConfigs.correlation, 'agent7', 'agent7-correlation');
        this.pushAiAgentIfKeyed(agentDefinitions, agentConfigs.reporting, 'agent8', 'agent8-reporting');
        this.pushAiAgentIfKeyed(agentDefinitions, agentConfigs.remediation, 'agent9', 'agent9-remediation');
        this.pushAiAgentIfKeyed(agentDefinitions, agentConfigs.chatops, 'agent10', 'agent10-chatops');

        for (const agentDef of agentDefinitions) {
            this.agents.set(agentDef.name, {
                ...agentDef,
                process: null,
                status: 'stopped',
                lastHealthCheck: null,
                restartCount: 0
            });
        }

        logger.info(`Initialized ${this.agents.size} agents`);
    }

    /**
     * Start a specific agent
     */
    startAgent(agentName) {
        const agent = this.agents.get(agentName);

        if (!agent) {
            throw new Error(`Agent ${agentName} not found`);
        }

        if (!agent.enabled) {
            logger.warn(`Agent ${agentName} is disabled in configuration`);
            return false;
        }

        if (agent.status === 'running') {
            logger.warn(`Agent ${agentName} is already running`);
            return false;
        }

        try {
            logger.info(`Starting agent: ${agentName}`);

            const child = spawn(agent.startCommand, agent.startArgs, {
                cwd: agent.path,
                stdio: ['ignore', 'pipe', 'pipe'],
                detached: false,
                shell: true,
                env: {
                    ...process.env,
                    PORT: String(agent.port),
                    METRICS_PORT: String(agent.port)
                }
            });

            child.stdout.on('data', (data) => {
                logger.debug(`[${agentName}] ${data.toString().trim()}`);
            });

            child.stderr.on('data', (data) => {
                logger.error(`[${agentName}] ${data.toString().trim()}`);
            });

            child.on('error', (error) => {
                logger.error(`Agent ${agentName} process error: ${error.message}`);
                agent.status = 'error';
                agent.process = null;
            });

            child.on('exit', (code, signal) => {
                logger.warn(`Agent ${agentName} exited with code ${code}, signal ${signal}`);
                agent.status = 'stopped';
                agent.process = null;

                // Auto-restart if configured
                if (code !== 0 && agent.restartCount < 3) {
                    logger.info(`Auto-restarting ${agentName} (attempt ${agent.restartCount + 1}/3)`);
                    agent.restartCount++;
                    setTimeout(() => this.startAgent(agentName), 5000);
                }
            });

            agent.process = child;
            agent.status = 'starting';

            // Wait a bit then check if it's running
            setTimeout(() => {
                if (agent.process && !agent.process.killed) {
                    agent.status = 'running';
                    logger.info(`Agent ${agentName} started successfully on port ${agent.port}`);
                }
            }, 3000);

            return true;
        } catch (error) {
            logger.error(`Failed to start agent ${agentName}: ${error.message}`);
            agent.status = 'error';
            throw error;
        }
    }

    /**
     * Stop a specific agent
     */
    stopAgent(agentName) {
        const agent = this.agents.get(agentName);

        if (!agent) {
            throw new Error(`Agent ${agentName} not found`);
        }

        if (agent.status === 'stopped') {
            logger.warn(`Agent ${agentName} is already stopped`);
            return false;
        }

        try {
            logger.info(`Stopping agent: ${agentName}`);

            if (agent.process) {
                agent.process.kill('SIGTERM');

                // Force kill after 10 seconds if not stopped
                setTimeout(() => {
                    if (agent.process && !agent.process.killed) {
                        logger.warn(`Force killing agent ${agentName}`);
                        agent.process.kill('SIGKILL');
                    }
                }, 10000);
            }

            agent.status = 'stopped';
            agent.process = null;
            logger.info(`Agent ${agentName} stopped`);
            return true;
        } catch (error) {
            logger.error(`Failed to stop agent ${agentName}: ${error.message}`);
            throw error;
        }
    }

    /**
     * Restart a specific agent
     */
    async restartAgent(agentName) {
        logger.info(`Restarting agent: ${agentName}`);
        this.stopAgent(agentName);

        // Wait for process to stop
        await new Promise(resolve => setTimeout(resolve, 2000));

        return this.startAgent(agentName);
    }

    /**
     * Start all enabled agents
     */
    startAllAgents() {
        logger.info('Starting all enabled agents...');
        let started = 0;

        for (const [name, agent] of this.agents) {
            if (agent.enabled) {
                try {
                    this.startAgent(name);
                    started++;
                } catch (error) {
                    logger.error(`Failed to start ${name}: ${error.message}`);
                }
            }
        }

        logger.info(`Started ${started} agents`);
        return started;
    }

    /**
     * Stop all agents
     */
    stopAllAgents() {
        logger.info('Stopping all agents...');
        let stopped = 0;

        for (const [name] of this.agents) {
            try {
                this.stopAgent(name);
                stopped++;
            } catch (error) {
                logger.error(`Failed to stop ${name}: ${error.message}`);
            }
        }

        logger.info(`Stopped ${stopped} agents`);
        return stopped;
    }

    /**
     * Check health of a specific agent
     */
    async checkAgentHealth(agentName) {
        const agent = this.agents.get(agentName);

        if (!agent) {
            return { healthy: false, error: 'Agent not found' };
        }

        if (agent.status !== 'running') {
            return { healthy: false, status: agent.status };
        }

        try {
            const response = await axios.get(`http://localhost:${agent.port}${agent.healthEndpoint}`, {
                timeout: 5000
            });

            agent.lastHealthCheck = new Date();
            return {
                healthy: true,
                status: agent.status,
                data: response.data
            };
        } catch (error) {
            logger.warn(`Health check failed for ${agentName}: ${error.message}`);
            return {
                healthy: false,
                status: agent.status,
                error: error.message
            };
        }
    }

    /**
     * Check health of all agents
     */
    async checkAllAgentsHealth() {
        const healthStatus = {};

        for (const [name] of this.agents) {
            healthStatus[name] = await this.checkAgentHealth(name);
        }

        return healthStatus;
    }

    /**
     * Get status of all agents
     */
    getAllAgentsStatus() {
        const status = {};

        for (const [name, agent] of this.agents) {
            status[name] = {
                enabled: agent.enabled,
                status: agent.status,
                port: agent.port,
                lastHealthCheck: agent.lastHealthCheck,
                restartCount: agent.restartCount
            };
        }

        return status;
    }

    /**
     * Start periodic health checks
     */
    startHealthMonitoring(interval = 30000) {
        if (this.healthCheckInterval) {
            clearInterval(this.healthCheckInterval);
        }

        logger.info(`Starting health monitoring (interval: ${interval}ms)`);

        this.healthCheckInterval = setInterval(async () => {
            const health = await this.checkAllAgentsHealth();

            for (const [name, status] of Object.entries(health)) {
                if (!status.healthy && this.agents.get(name).enabled) {
                    logger.warn(`Agent ${name} is unhealthy: ${status.error || status.status}`);
                }
            }
        }, interval);
    }

    /**
     * Stop health monitoring
     */
    stopHealthMonitoring() {
        if (this.healthCheckInterval) {
            clearInterval(this.healthCheckInterval);
            this.healthCheckInterval = null;
            logger.info('Health monitoring stopped');
        }
    }
}

module.exports = new AgentManager();
