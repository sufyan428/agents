const cron = require('node-cron');
const logger = require('../utils/logger');

class ReportScheduler {
  constructor(config, reportGenerator) {
    this.config = config;
    this.reportGenerator = reportGenerator;
    this.cronTask = null;
    this.running = false;
  }

  start() {
    const expr = this.config.schedule.digest_cron;
    logger.info(`Scheduling digest report: ${expr}`);
    this.cronTask = cron.schedule(expr, () => this.runScheduledDigest());
  }

  stop() {
    if (this.cronTask) {
      this.cronTask.stop();
    }
  }

  async runScheduledDigest() {
    if (this.running) {
      logger.warn('Previous scheduled digest still running, skipping this cycle');
      return;
    }
    this.running = true;
    try {
      await this.reportGenerator.generate('scheduled-digest');
    } catch (error) {
      logger.error(`Scheduled digest failed: ${error.message}`);
    } finally {
      this.running = false;
    }
  }
}

module.exports = ReportScheduler;
