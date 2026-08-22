const { createServer } = require('@ragent/agent-common');
const logger = require('./utils/logger');
const agentManager = require('./agent-manager');
const configManager = require('./config-manager');
const correlationEngine = require('./correlation');

/**
 * Orchestrator API gateway.
 *
 * Every mutating route here can stop, start, or restart an agent, or rewrite
 * every downstream agent's configuration. Before this rewrite they were all
 * reachable with an unauthenticated POST from anywhere on the network, and
 * `cors()` with no options meant any website the operator visited could call
 * them too.
 *
 * Auth, binding, CORS, rate limiting, body limits and error redaction now come
 * from the shared server factory, so they cannot drift out of sync with the
 * other nine agents.
 */
class APIGateway {
  constructor() {
    this.server = null;
  }

  /**
   * Reads the shared secret. Absent means mutating routes fail closed with a
   * 503 rather than staying open - see the factory's auth middleware.
   */
  static authToken() {
    const token = (process.env.AGENT_API_TOKEN || '').trim();
    return token.length > 0 ? token : undefined;
  }

  static corsOrigins() {
    return (process.env.AGENT_CORS_ORIGINS || '')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean);
  }

  setupRoutes(app) {
    // ---- read-only -----------------------------------------------------

    app.get('/api/agents', (req, res) => {
      res.json({ success: true, agents: agentManager.getAllAgentsStatus() });
    });

    app.get('/api/agents/:name', (req, res) => {
      const status = agentManager.getAllAgentsStatus()[req.params.name];
      if (!status) {
        return res.status(404).json({ success: false, error: 'Agent not found' });
      }
      res.json({ success: true, agent: status });
    });

    app.get('/api/health/agents', async (req, res, next) => {
      try {
        res.json({ success: true, health: await agentManager.checkAllAgentsHealth() });
      } catch (err) {
        next(err);
      }
    });

    app.get('/api/health/agents/:name', async (req, res, next) => {
      try {
        res.json({ success: true, health: await agentManager.checkAgentHealth(req.params.name) });
      } catch (err) {
        next(err);
      }
    });

    app.get('/api/overview', async (req, res, next) => {
      try {
        const agentsStatus = agentManager.getAllAgentsStatus();
        const health = await agentManager.checkAllAgentsHealth();

        const overview = {
          totalAgents: Object.keys(agentsStatus).length,
          runningAgents: Object.values(agentsStatus).filter((a) => a.status === 'running').length,
          healthyAgents: Object.values(health).filter((h) => h.healthy).length,
          agents: {},
        };
        for (const [name, status] of Object.entries(agentsStatus)) {
          overview.agents[name] = { ...status, healthy: health[name]?.healthy || false };
        }
        res.json({ success: true, overview });
      } catch (err) {
        next(err);
      }
    });

    // Deterministic cross-agent incidents. Available with no API key and
    // no model - this is the framework's own correlation, which agent7
    // enriches rather than provides.
    app.get('/api/incidents', (req, res, next) => {
      try {
        res.json({ success: true, ...correlationEngine.snapshot() });
      } catch (err) {
        next(err);
      }
    });

    // Incidents from previous runs, including ones that ended. The question an
    // operator asks about a recurring fault is "has this happened before?",
    // which the framework could not answer at all while state lived in memory.
    app.get('/api/incidents/history', (req, res, next) => {
      try {
        const requested = Number.parseInt(req.query.limit, 10);
        const limit = Math.min(Math.max(Number.isFinite(requested) ? requested : 50, 1), 500);
        res.json({ success: true, incidents: correlationEngine.incidentHistory(limit) });
      } catch (err) {
        next(err);
      }
    });

    app.get('/api/config', (req, res, next) => {
      try {
        res.json({ success: true, config: configManager.getRedactedConfig() });
      } catch (err) {
        next(err);
      }
    });

    // ---- mutating: the factory requires a bearer token on all of these ---

    app.post('/api/agents/start-all', (req, res, next) => {
      try {
        res.json({ success: true, message: `Started ${agentManager.startAllAgents()} agents` });
      } catch (err) {
        next(err);
      }
    });

    app.post('/api/agents/stop-all', (req, res, next) => {
      try {
        res.json({ success: true, message: `Stopped ${agentManager.stopAllAgents()} agents` });
      } catch (err) {
        next(err);
      }
    });

    app.post('/api/agents/:name/start', (req, res, next) => {
      try {
        const started = agentManager.startAgent(req.params.name);
        res.json({
          success: started,
          message: started
            ? `Agent ${req.params.name} started`
            : `Agent ${req.params.name} is already running or disabled`,
        });
      } catch (err) {
        next(err);
      }
    });

    app.post('/api/agents/:name/stop', (req, res, next) => {
      try {
        const stopped = agentManager.stopAgent(req.params.name);
        res.json({
          success: stopped,
          message: stopped
            ? `Agent ${req.params.name} stopped`
            : `Agent ${req.params.name} is already stopped`,
        });
      } catch (err) {
        next(err);
      }
    });

    app.post('/api/agents/:name/restart', async (req, res, next) => {
      try {
        await agentManager.restartAgent(req.params.name);
        res.json({ success: true, message: `Agent ${req.params.name} restarted` });
      } catch (err) {
        next(err);
      }
    });

    // Runtime toggles. Mutating, so the factory requires a token.
    const toggle = (enabled) => (req, res, next) => {
      if (!agentManager.has(req.params.name)) {
        return res.status(404).json({ success: false, error: 'Agent not found' });
      }
      try {
        res.json({ success: true, ...agentManager.setEnabled(req.params.name, enabled) });
      } catch (err) {
        next(err);
      }
    };
    app.post('/api/agents/:name/enable', toggle(true));
    app.post('/api/agents/:name/disable', toggle(false));

    app.post('/api/config/reload', (req, res, next) => {
      try {
        configManager.loadMasterConfig();
        const result = configManager.distributeConfigs();
        res.json({
          success: true,
          message: 'Configuration reloaded',
          written: result.written,
          unchanged: result.unchanged,
        });
      } catch (err) {
        next(err);
      }
    });
  }

  async start(port, host) {
    const token = APIGateway.authToken();
    if (!token) {
      logger.warn(
        'AGENT_API_TOKEN is not set. Read-only endpoints work, but every control ' +
          'endpoint (start/stop/restart/config reload) will refuse with 503. ' +
          "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
      );
    }

    this.server = createServer({
      agent: 'agent6-orchestrator',
      logger,
      port,
      host,
      authToken: token,
      corsOrigins: APIGateway.corsOrigins(),
      rateLimit: { windowMs: 60_000, max: 240 },
      healthChecks: () => {
        const statuses = agentManager.getAllAgentsStatus();
        return Object.entries(statuses)
          .filter(([, a]) => a.enabled)
          .map(([name, a]) => ({
            name,
            // A child that is not running degrades the orchestrator; it
            // does not make the orchestrator itself unhealthy, and must
            // not cause a supervisor to restart it.
            status: a.status === 'running' ? 'healthy' : 'degraded',
            message: a.status === 'running' ? undefined : `agent is ${a.status}`,
            simulated: false,
          }));
      },
    });

    this.setupRoutes(this.server.app);
    await this.server.listen();
  }

  async stop() {
    if (this.server) await this.server.close();
  }
}

module.exports = new APIGateway();
