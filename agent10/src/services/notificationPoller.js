const cron = require('node-cron');
const axios = require('axios');
const logger = require('../utils/logger');

class NotificationPoller {
  constructor(config, notifier) {
    this.config = config;
    this.notifier = notifier;
    this.cronTask = null;
    this.running = false;
    this.history = [];
    this.lastSeenIncidentId = null;
    this.lastSeenReportId = null;
  }

  start() {
    const interval = this.config.notifications.poll_interval_seconds;
    const cronExpr = this.buildCronExpr(interval);
    logger.info(`Starting notification poll (every ${interval}s, cron: "${cronExpr}")`);
    this.cronTask = cron.schedule(cronExpr, () => this.tick());
  }

  stop() {
    if (this.cronTask) {
      this.cronTask.stop();
    }
  }

  // node-cron's seconds field only accepts 0-59; for intervals over that,
  // step the minutes field instead of the (invalid) `*/N` seconds shorthand.
  buildCronExpr(intervalSeconds) {
    if (intervalSeconds < 60) {
      return `*/${intervalSeconds} * * * * *`;
    }
    if (intervalSeconds % 60 === 0) {
      return `0 */${intervalSeconds / 60} * * * *`;
    }
    throw new Error(
      `notifications.poll_interval_seconds (${intervalSeconds}) must be under 60, or an exact multiple of 60`,
    );
  }

  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      await this.checkIncidents();
      await this.checkReports();
    } catch (error) {
      logger.error(`Notification poll failed: ${error.message}`);
    } finally {
      this.running = false;
    }
  }

  async checkIncidents() {
    try {
      const res = await axios.get(`${this.config.sources.agent7_url}/api/incidents`, {
        timeout: this.config.sources.timeout_ms,
      });
      const latest = res.data.latest;
      if (latest && latest.timestamp !== this.lastSeenIncidentId) {
        this.lastSeenIncidentId = latest.timestamp;
        const text = `New incident correlation:\n${latest.analysis}`;
        await this.notifier.send(text);
        this.record('incident', text);
      }
    } catch (_error) {
      // agent7 optional/unreachable - nothing to push, not an error worth logging repeatedly
    }
  }

  async checkReports() {
    try {
      const res = await axios.get(`${this.config.sources.agent8_url}/api/reports/latest`, {
        timeout: this.config.sources.timeout_ms,
      });
      const latest = res.data.report;
      if (latest && latest.id !== this.lastSeenReportId) {
        this.lastSeenReportId = latest.id;
        const text = `New digest report (${latest.label}):\n${latest.markdown}`;
        await this.notifier.send(text);
        this.record('report', text);
      }
    } catch (_error) {
      // agent8 optional/unreachable
    }
  }

  record(type, text) {
    this.history.push({
      id: `${type}-${Date.now()}`,
      type,
      timestamp: new Date().toISOString(),
      text,
    });
    const maxSize = this.config.notifications.history_size;
    if (this.history.length > maxSize) {
      this.history.shift();
    }
  }

  getHistory() {
    return this.history;
  }
}

module.exports = NotificationPoller;
