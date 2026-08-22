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
    for (const [name, agent] of Object.entries(snapshot.agents)) {
      if (!agent.reachable) return true;
      const status = agent.health?.status || agent.health?.healthy;
      if (status === false || status === 'unhealthy') return true;
    }

    if (snapshot.orchestrator && previousSnapshot?.orchestrator) {
      for (const [name, current] of Object.entries(snapshot.orchestrator.agents || {})) {
        const previous = previousSnapshot.orchestrator.agents?.[name];
        if (previous && (current.healthy !== previous.healthy || current.status !== previous.status)) {
          return true;
        }
      }
    }

    if (!snapshot.orchestratorReachable) return true;

    return false;
  }
}

module.exports = Collector;
