const axios = require('axios');
const logger = require('../utils/logger');

class DataCollector {
  constructor(config) {
    this.config = config;
  }

  /**
   * Pull everything the digest needs: agent5's structured report types
   * (compliance/audit/configuration/self_healing - already-computed JSON, not
   * re-collected here), the orchestrator's live agent health overview, and
   * agent7's recent correlation findings if that agent is running. Any single
   * source failing is recorded, not thrown - a partial digest is still useful.
   */
  async collect() {
    const data = {
      timestamp: new Date().toISOString(),
      orchestratorOverview: null,
      agent5Reports: {},
      agent7Incidents: null
    };

    try {
      const res = await axios.get(`${this.config.orchestrator.base_url}/api/overview`, {
        timeout: this.config.sources.timeout_ms
      });
      data.orchestratorOverview = res.data.overview;
    } catch (error) {
      logger.warn(`Orchestrator overview unreachable: ${error.message}`);
    }

    await Promise.all(
      this.config.sources.report_types.map(async (reportType) => {
        try {
          const res = await axios.post(
            `${this.config.sources.agent5_url}/api/reports/generate`,
            { reportType },
            { timeout: this.config.sources.timeout_ms }
          );
          data.agent5Reports[reportType] = res.data;
        } catch (error) {
          data.agent5Reports[reportType] = { error: error.message };
          logger.warn(`agent5 ${reportType} report unavailable: ${error.message}`);
        }
      })
    );

    try {
      const res = await axios.get(`${this.config.sources.agent7_url}/api/incidents`, {
        timeout: this.config.sources.timeout_ms
      });
      data.agent7Incidents = res.data;
    } catch (error) {
      logger.info(`agent7 incidents unavailable (optional, likely disabled/no API key): ${error.message}`);
    }

    return data;
  }
}

module.exports = DataCollector;
