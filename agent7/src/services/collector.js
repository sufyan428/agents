const axios = require('axios');
const logger = require('../utils/logger');

class Collector {
  constructor(config) {
    this.config = config;
  }

  /**
   * Gather a combined snapshot: orchestrator's aggregate overview (status/port/
   * healthy per agent) plus each agent's own richer /health payload. Any single
   * agent being unreachable is recorded, not thrown - a partial snapshot is
   * still useful input for correlation.
   */
  async collect() {
    const snapshot = {
      timestamp: new Date().toISOString(),
      orchestrator: null,
      orchestratorReachable: false,
      agents: {}
    };

    try {
      const res = await axios.get(`${this.config.orchestrator.base_url}/api/overview`, {
        timeout: this.config.orchestrator.timeout_ms
      });
      snapshot.orchestrator = res.data.overview;
      snapshot.orchestratorReachable = true;
    } catch (error) {
      logger.warn(`Orchestrator overview unreachable: ${error.message}`);
    }

    await Promise.all(
      this.config.agents.map(async (agent) => {
        try {
          const res = await axios.get(`http://localhost:${agent.port}/health`, {
            timeout: this.config.orchestrator.timeout_ms
          });
          snapshot.agents[agent.name] = {
            reachable: true,
            port: agent.port,
            health: res.data
          };
        } catch (error) {
          snapshot.agents[agent.name] = {
            reachable: false,
            port: agent.port,
            error: error.message
          };
        }
      })
    );

    return snapshot;
  }

  /**
   * Cheap heuristic gate for whether this snapshot is worth an LLM call:
   * any agent unreachable/unhealthy, or an orchestrator-reported status flip
   * since the previous snapshot.
   */
  static hasAnomaly(snapshot, previousSnapshot) {
    // Agents the orchestrator reports as disabled are absent on purpose. Before
    // this, switching an agent off made every subsequent poll look anomalous,
    // so the AI layer spent a model call every cycle - forever - reporting the
    // same non-event.
    const disabled = new Set(
      Object.entries(snapshot.orchestrator?.agents || {})
        .filter(([, a]) => a.enabled === false)
        .map(([name]) => name)
    );

    for (const [name, agent] of Object.entries(snapshot.agents)) {
      if (disabled.has(name)) continue;
      if (!agent.reachable) return true;
      const status = agent.health?.status || agent.health?.healthy;
      // 'degraded' is deliberately not an anomaly: it is the normal report
      // from an agent whose monitored device is unreachable, which in a lab or
      // a hardware outage is a steady state, not a new event.
      if (status === false || status === 'unhealthy') return true;
    }

    if (snapshot.orchestrator && previousSnapshot?.orchestrator) {
      for (const [name, current] of Object.entries(snapshot.orchestrator.agents || {})) {
        const previous = previousSnapshot.orchestrator.agents?.[name];
        if (!previous) continue;
        // An operator toggling an agent is an intended change, not an incident.
        if (current.enabled !== previous.enabled) continue;
        if (current.enabled === false) continue;
        if (current.healthy !== previous.healthy || current.status !== previous.status) {
          return true;
        }
      }
    }

    if (!snapshot.orchestratorReachable) return true;

    return false;
  }
}

module.exports = Collector;
