const cron = require('node-cron');
const logger = require('../utils/logger');
const Collector = require('./collector');

const SYSTEM_PROMPT = `You are a network operations correlation analyst for a 5-agent router monitoring framework:
- agent1-monitoring: SNMP/syslog metrics collection (CPU, memory, bandwidth, uptime)
- agent2-resilience: failover between primary/backup routers via SNMP+ICMP heartbeat
- agent3-security: intrusion detection - auth failures, traffic anomalies, config validation, syslog/SNMP-trap ingestion
- agent4-performance: QoS and traffic optimization, ICMP latency/jitter/packet-loss tracking
- agent5-automation: policy compliance checks and config governance/backups

You will be given a JSON snapshot of each agent's current health/status, and may be given recent snapshot history for trend context. Your job:
1. Identify whether any signals across DIFFERENT agents are likely related (e.g. a security alert and a failover event in the same window suggest one root cause, not two).
2. State a root-cause hypothesis in plain language, with a confidence level (low/medium/high).
3. Note whether this looks like a real incident, expected noise (e.g. no real router hardware reachable in a dev/test environment), or a genuine anomaly worth a human's attention.
4. Suggest one concrete next step.

Be concise - a few sentences, not a report. If nothing across agents correlates and everything looks like isolated, expected behavior, say so plainly in one sentence rather than padding the analysis.`;

class CorrelationEngine {
  constructor(config, llmClient) {
    this.config = config;
    this.llmClient = llmClient;
    this.collector = new Collector(config);
    this.history = [];
    this.latestResult = null;
    this.pollCount = 0;
    this.running = false;
    this.cronTask = null;

    this.metrics = {
      pollsTotal: 0,
      llmCallsTotal: 0,
      llmErrorsTotal: 0,
      lastPollAt: null,
      lastLlmCallAt: null
    };
  }

  start() {
    const interval = this.config.correlation.poll_interval_seconds;
    const cronExpr = this.buildCronExpr(interval);
    logger.info(`Starting correlation loop (every ${interval}s, cron: "${cronExpr}")`);
    this.cronTask = cron.schedule(cronExpr, () => this.tick());
  }

  // node-cron's seconds field only accepts 0-59, so an N-step there with N
  // over 59 doesn't mean "every N seconds" - it silently collapses to
  // matching only second 0 (i.e. once a minute). That happens to be correct
  // for N=60 specifically, but wrong for any other multi-minute value, so
  // step minutes instead.
  buildCronExpr(intervalSeconds) {
    if (intervalSeconds < 60) {
      return `*/${intervalSeconds} * * * * *`;
    }
    if (intervalSeconds % 60 === 0) {
      return `0 */${intervalSeconds / 60} * * * *`;
    }
    throw new Error(
      `correlation.poll_interval_seconds (${intervalSeconds}) must be under 60, or an exact multiple of 60`
    );
  }

  stop() {
    if (this.cronTask) {
      this.cronTask.stop();
    }
  }

  async tick() {
    if (this.running) {
      logger.warn('Previous correlation tick still running, skipping this cycle');
      return;
    }
    this.running = true;

    try {
      const snapshot = await this.collector.collect();
      this.metrics.pollsTotal++;
      this.metrics.lastPollAt = snapshot.timestamp;
      this.pollCount++;

      const previousSnapshot = this.history[this.history.length - 1] || null;
      this.pushHistory(snapshot);

      const isAnomaly = Collector.hasAnomaly(snapshot, previousSnapshot);
      const isBaselineDue = this.pollCount % this.config.correlation.baseline_every_n_polls === 0;
      const shouldAnalyze = !this.config.correlation.anomaly_only || isAnomaly || isBaselineDue;

      if (!shouldAnalyze) {
        return;
      }

      logger.info(`Running correlation analysis (anomaly=${isAnomaly}, baseline=${isBaselineDue})`);
      const userContent = JSON.stringify(
        {
          current: snapshot,
          recentHistory: this.history.slice(-5, -1)
        },
        null,
        2
      );

      this.metrics.llmCallsTotal++;
      this.metrics.lastLlmCallAt = new Date().toISOString();
      const result = await this.llmClient.analyze(SYSTEM_PROMPT, userContent);

      if (result && result.text) {
        this.latestResult = {
          timestamp: new Date().toISOString(),
          triggeredBy: isAnomaly ? 'anomaly' : 'baseline',
          analysis: result.text,
          usage: result.usage
        };
        logger.info(`Correlation result: ${result.text.slice(0, 200)}`);
      } else {
        this.metrics.llmErrorsTotal++;
      }
    } catch (error) {
      logger.error(`Correlation tick failed: ${error.message}`);
    } finally {
      this.running = false;
    }
  }

  pushHistory(snapshot) {
    this.history.push(snapshot);
    const maxSize = this.config.correlation.history_size;
    if (this.history.length > maxSize) {
      this.history.shift();
    }
  }

  async askQuestion(question) {
    const snapshot = await this.collector.collect();
    const userContent = JSON.stringify(
      {
        question,
        current: snapshot,
        recentHistory: this.history.slice(-10)
      },
      null,
      2
    );

    const qaSystemPrompt = `${SYSTEM_PROMPT}\n\nA human operator has asked a direct question. Answer it using the provided snapshot and history data; if the data doesn't cover what they're asking, say so rather than guessing.`;
    return this.llmClient.analyze(qaSystemPrompt, userContent);
  }

  getLatestSnapshot() {
    return this.history[this.history.length - 1] || null;
  }

  getHistory() {
    return this.history;
  }

  getLatestResult() {
    return this.latestResult;
  }

  getMetrics() {
    return this.metrics;
  }
}

module.exports = CorrelationEngine;
