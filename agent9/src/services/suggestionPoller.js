const cron = require('node-cron');
const logger = require('../utils/logger');

class SuggestionPoller {
  constructor(config, remediationAdvisor) {
    this.config = config;
    this.remediationAdvisor = remediationAdvisor;
    this.cronTask = null;
    this.running = false;
  }

  start() {
    const interval = this.config.polling.interval_seconds;
    const cronExpr = this.buildCronExpr(interval);
    logger.info(`Starting remediation suggestion poll (every ${interval}s, cron: "${cronExpr}")`);
    this.cronTask = cron.schedule(cronExpr, () => this.tick());
  }

  // node-cron's seconds field only accepts 0-59, so an N-step there with N
  // over 59 doesn't mean "every N seconds" - it silently collapses to
  // matching only second 0 (i.e. once a minute), which is wrong for anything
  // but N=60. For multi-minute intervals, step the minutes field instead.
  buildCronExpr(intervalSeconds) {
    if (intervalSeconds < 60) {
      return `*/${intervalSeconds} * * * * *`;
    }
    if (intervalSeconds % 60 === 0) {
      return `0 */${intervalSeconds / 60} * * * *`;
    }
    throw new Error(
      `polling.interval_seconds (${intervalSeconds}) must be under 60, or an exact multiple of 60`
    );
  }

  stop() {
    if (this.cronTask) {
      this.cronTask.stop();
    }
  }

  async tick() {
    if (this.running) {
      logger.warn('Previous suggestion poll still running, skipping this cycle');
      return;
    }
    this.running = true;
    try {
      const result = await this.remediationAdvisor.suggestRemediation();
      if (result && result.text) {
        logger.info(`Suggestion check complete: ${result.text.slice(0, 150)}`);
      }
    } catch (error) {
      logger.error(`Suggestion poll failed: ${error.message}`);
    } finally {
      this.running = false;
    }
  }
}

module.exports = SuggestionPoller;
