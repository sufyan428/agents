const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const logger = require('./utils/logger');

const MAX_RESTARTS = 5;
const RESTART_BASE_DELAY_MS = 2000;
/** Uptime after which an agent is considered stable and its crash count resets. */
const STABLE_AFTER_MS = 60_000;

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

            // shell:false. With a shell, kill() terminated the shell and left
            // the real node process orphaned, still holding its port - which is
            // why a stale-port cleanup hook had to exist. On Windows npm is a
            // .cmd, so the command is resolved explicitly instead.
            // detached:true puts the child in its own process group, so a stop
            // can signal the whole tree rather than just the immediate child.
            const isWindows = process.platform === 'win32';
            const command = agent.startCommand === 'npm' && isWindows ? 'npm.cmd' : agent.startCommand;

            const child = spawn(command, agent.startArgs, {
                cwd: agent.path,
                stdio: ['ignore', 'pipe', 'pipe'],
                detached: !isWindows,
                shell: false,
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
                if (agent.healthyTimer) {
                    clearTimeout(agent.healthyTimer);
                    agent.healthyTimer = null;
                }

                // A deliberate stop must stay stopped. Previously the guard was
                // `code !== 0`, and a SIGTERM exit reports code null - so
                // stopping an agent through the API restarted it 5s later.
                if (agent.intentionalStop) {
                    agent.intentionalStop = false;
                    return;
                }

                if (agent.restartCount >= MAX_RESTARTS) {
                    logger.error(
                        `Agent ${agentName} has crashed ${agent.restartCount} times; not restarting again. ` +
                        'Fix the underlying fault and start it explicitly.'
                    );
                    agent.status = 'failed';
                    return;
                }

                agent.restartCount++;
                // Exponential backoff. A crash-looping agent previously retried
                // on a flat 5s timer, which just filled the logs faster.
                const delay = Math.min(RESTART_BASE_DELAY_MS * 2 ** (agent.restartCount - 1), 60_000);
                logger.info(
                    `Auto-restarting ${agentName} in ${delay}ms (attempt ${agent.restartCount}/${MAX_RESTARTS})`
                );
                agent.restartTimer = setTimeout(() => this.startAgent(agentName), delay);
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

            // An agent that stays up is no longer crash-looping, so its restart
            // budget is returned. Previously restartCount only ever increased,
            // so an agent that crashed three times months apart would never be
            // auto-restarted again.
            agent.healthyTimer = setTimeout(() => {
                if (agent.status === 'running' && agent.restartCount > 0) {
                    logger.info(`Agent ${agentName} stable for 60s, resetting its restart counter`);
                    agent.restartCount = 0;
                }
            }, STABLE_AFTER_MS);
            agent.healthyTimer.unref?.();

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

            // Marks this as deliberate so the exit handler does not treat it as
            // a crash and restart the agent five seconds later.
            agent.intentionalStop = true;

            if (agent.restartTimer) {
                clearTimeout(agent.restartTimer);
                agent.restartTimer = null;
            }
            if (agent.healthyTimer) {
                clearTimeout(agent.healthyTimer);
                agent.healthyTimer = null;
            }

            const child = agent.process;
            if (child) {
                this.signalTree(child, 'SIGTERM', agentName);

                // Escalate if it has not exited. This previously never ran:
                // agent.process was set to null immediately below, so by the
                // time the timer fired the guard `if (agent.process ...)` was
                // always false and SIGKILL was unreachable.
                const force = setTimeout(() => {
                    if (child.exitCode === null && child.signalCode === null) {
                        logger.warn(`Agent ${agentName} ignored SIGTERM, sending SIGKILL`);
                        this.signalTree(child, 'SIGKILL', agentName);
                    }
                }, 10000);
                force.unref?.();
                child.once('exit', () => clearTimeout(force));
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
     * Signals the child's whole process group where the platform supports it.
     *
     * `npm start` spawns node as a grandchild, so signalling only the immediate
     * child leaves the actual agent running and holding its port. On POSIX the
     * child is detached into its own group and the negated pid reaches all of
     * it; Windows has no process groups, so taskkill /T does the same job.
     */
    signalTree(child, signal, agentName) {
        if (!child || child.pid === undefined) return;
        try {
            if (process.platform === 'win32') {
                const { execFileSync } = require('child_process');
                const args = ['/pid', String(child.pid), '/T'];
                if (signal === 'SIGKILL') args.push('/F');
                execFileSync('taskkill', args, { stdio: 'ignore' });
            } else {
                process.kill(-child.pid, signal);
            }
        } catch (error) {
            // ESRCH simply means it already exited between the check and the signal.
            if (error.code !== 'ESRCH') {
                logger.debug(`Could not signal ${agentName} process tree: ${error.message}`);
            }
            try { child.kill(signal); } catch { /* already gone */ }
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
