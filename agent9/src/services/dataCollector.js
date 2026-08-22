const axios = require('axios');
const logger = require('../utils/logger');

class DataCollector {
  constructor(config) {
    this.config = config;
  }

  async getComplianceViolations() {
    try {
      const res = await axios.post(
        `${this.config.sources.agent5_url}/api/compliance/check`,
        {},
        { timeout: this.config.sources.timeout_ms }
      );
      return { reachable: true, data: res.data };
    } catch (error) {
      logger.warn(`agent5 compliance check unavailable: ${error.message}`);
      return { reachable: false, error: error.message };
    }
  }

  async getPerformanceHealth() {
    try {
      const res = await axios.get(`${this.config.sources.agent4_url}/health`, {
        timeout: this.config.sources.timeout_ms
      });
      return { reachable: true, data: res.data };
    } catch (error) {
      logger.warn(`agent4 health unavailable: ${error.message}`);
      return { reachable: false, error: error.message };
    }
  }

  async getLatestIncident() {
    try {
      const res = await axios.get(`${this.config.sources.agent7_url}/api/incidents`, {
        timeout: this.config.sources.timeout_ms
      });
      return { reachable: true, data: res.data };
    } catch (error) {
      logger.info(`agent7 incidents unavailable (optional): ${error.message}`);
      return { reachable: false, error: error.message };
    }
  }

  /**
   * Anything worth generating a suggestion for right now: real compliance
   * violations, or agent4's efficiency score under the configured threshold.
   */
  async findIssues() {
    const [compliance, performance] = await Promise.all([
      this.getComplianceViolations(),
      this.getPerformanceHealth()
    ]);

    const violations = compliance.reachable
      ? (compliance.data.results || []).flatMap((r) => r.violations || [])
      : [];

    const efficiencyScore = performance.reachable ? performance.data.efficiencyScore : null;
    const threshold = this.config.sources.efficiency_score_threshold;
    const performanceAnomaly = efficiencyScore !== null && efficiencyScore < threshold;

    return {
      hasIssues: violations.length > 0 || performanceAnomaly,
      violations,
      performance: { reachable: performance.reachable, efficiencyScore, belowThreshold: performanceAnomaly },
      compliance
    };
  }
}

module.exports = DataCollector;
