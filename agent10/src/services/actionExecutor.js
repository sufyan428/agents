const axios = require('axios');
const logger = require('../utils/logger');

/**
 * Every action the chat interface can take, and whether it needs human
 * confirmation before running. This is the single source of truth both the
 * chat engine (to decide whether to confirm) and the API routes (to
 * re-validate a confirmed action) consult - the LLM's output is never
 * trusted to execute anything on its own say-so.
 */
const ACTIONS = {
  get_overview: { destructive: false, needsAgentName: false },
  get_agent_status: { destructive: false, needsAgentName: true },
  get_agent_health: { destructive: false, needsAgentName: true },
  get_incidents: { destructive: false, needsAgentName: false },
  get_reports: { destructive: false, needsAgentName: false },
  get_suggestions: { destructive: false, needsAgentName: false },
  restart_agent: { destructive: true, needsAgentName: true },
  stop_agent: { destructive: true, needsAgentName: true },
  start_agent: { destructive: true, needsAgentName: true },
  chat: { destructive: false, needsAgentName: false }
};

class ActionExecutor {
  constructor(config) {
    this.config = config;
  }

  isValidAction(action) {
    return Object.prototype.hasOwnProperty.call(ACTIONS, action);
  }

  isDestructive(action) {
    return this.isValidAction(action) && ACTIONS[action].destructive;
  }

  needsAgentName(action) {
    return this.isValidAction(action) && ACTIONS[action].needsAgentName;
  }

  isKnownAgent(agentName) {
    return this.config.known_agents.includes(agentName);
  }

  async execute(action, agentName) {
    const base = this.config.orchestrator.base_url;
    const timeout = this.config.orchestrator.timeout_ms;

    switch (action) {
      case 'get_overview': {
        const res = await axios.get(`${base}/api/overview`, { timeout });
        return res.data;
      }
      case 'get_agent_status': {
        const res = await axios.get(`${base}/api/agents/${agentName}`, { timeout });
        return res.data;
      }
      case 'get_agent_health': {
        const res = await axios.get(`${base}/api/health/agents/${agentName}`, { timeout });
        return res.data;
      }
      case 'restart_agent': {
        const res = await axios.post(`${base}/api/agents/${agentName}/restart`, {}, { timeout });
        return res.data;
      }
      case 'stop_agent': {
        const res = await axios.post(`${base}/api/agents/${agentName}/stop`, {}, { timeout });
        return res.data;
      }
      case 'start_agent': {
        const res = await axios.post(`${base}/api/agents/${agentName}/start`, {}, { timeout });
        return res.data;
      }
      case 'get_incidents': {
        const res = await axios.get(`${this.config.sources.agent7_url}/api/incidents`, {
          timeout: this.config.sources.timeout_ms
        });
        return res.data;
      }
      case 'get_reports': {
        const res = await axios.get(`${this.config.sources.agent8_url}/api/reports/latest`, {
          timeout: this.config.sources.timeout_ms
        });
        return res.data;
      }
      case 'get_suggestions': {
        const res = await axios.get(`${this.config.sources.agent9_url}/api/suggestions/latest`, {
          timeout: this.config.sources.timeout_ms
        });
        return res.data;
      }
      default:
        throw new Error(`Unknown action: ${action}`);
    }
  }

  async executeSafely(action, agentName) {
    try {
      const data = await this.execute(action, agentName);
      return { success: true, data };
    } catch (error) {
      // error.message is sometimes empty for connection-refused errors on Windows -
      // fall back to error.code so the failure is actually debuggable.
      const message = error.message || error.code || 'Unknown error';
      logger.warn(`Action ${action} (${agentName || 'n/a'}) failed: ${message}`);
      return { success: false, error: message };
    }
  }
}

module.exports = { ActionExecutor, ACTIONS };
