const axios = require('axios');
const { correlate, suppressibleFindingIds } = require('@ragent/analytics');
const { openStore } = require('@ragent/agent-common');
const logger = require('./utils/logger');

/**
 * Cross-agent incident correlation, with no model involved.
 *
 * Ten agents watching one network report the same event ten times. A router
 * loses power and the operator gets SNMP unreachable, ICMP loss, interface
 * down, heartbeat missed, compliance failed and backup failed - six alerts,
 * one cause. Paging someone six times is how alerting earns its reputation.
 *
 * This lives in agent6 rather than agent7 deliberately. The orchestrator is
 * always running; agent7 is optional and needs an API key. Putting correlation
 * behind that key would mean the framework only becomes coherent once you pay
 * for a model, and the whole design premise is that it works without one.
 *
 * agent7 then enriches these clusters rather than computing them: it is good at
 * explaining an incident in prose and suggesting next steps, and it should be
 * doing that on top of a root cause that was derived from a stated dependency
 * graph and can be defended.
 */
class CorrelationEngine {
  constructor(agentManager, { intervalMs = 30_000, windowMs = 300_000, historySize = 50 } = {}) {
    this.agentManager = agentManager;
    this.intervalMs = intervalMs;
    this.windowMs = windowMs;
    this.historySize = historySize;

    this.timer = null;
    // Incidents outlive the process. Without this, restarting the orchestrator
    // during an investigation loses the incident being investigated, and
    // "has this happened before?" is unanswerable.
    this.store = openStore('agent6-orchestrator', undefined, logger);
    this.clusters = [];
    this.lastRunAt = null;
    this.history = [];
    this.stats = {
      runs: 0,
      findingsSeen: 0,
      clustersFormed: 0,
      suppressed: 0,
      collectionFailures: 0,
    };
  }

  /**
   * Collects findings from every running agent.
   *
   * A disabled or unreachable agent contributes nothing and is not an error:
   * correlating over a partial view is still useful, and treating a switched-
   * off agent as a fault is exactly the confusion the toggle contract exists
   * to prevent.
   */
  async collectFindings() {
    const statuses = this.agentManager.getAllAgentsStatus();
    const targets = Object.entries(statuses).filter(([, a]) => a.enabled && a.status === 'running');

    const results = await Promise.all(
      targets.map(async ([name, agent]) => {
        try {
          const res = await axios.get(`http://127.0.0.1:${agent.port}/api/findings`, {
            timeout: 4000,
          });
          return Array.isArray(res.data?.findings) ? res.data.findings : [];
        } catch (error) {
          // Expected for agents that have not adopted the findings route yet.
          if (error.response?.status !== 404) {
            this.stats.collectionFailures++;
            logger.debug(`Could not collect findings from ${name}: ${error.message}`);
          }
          return [];
        }
      }),
    );

    return results.flat();
  }

  async run() {
    const findings = await this.collectFindings();
    this.stats.runs++;
    this.stats.findingsSeen = findings.length;
    this.lastRunAt = new Date().toISOString();

    if (findings.length === 0) {
      this.clusters = [];
      return { clusters: [], findings: 0 };
    }

    this.clusters = correlate(findings, { windowMs: this.windowMs });
    this.stats.clustersFormed = this.clusters.length;

    const suppressed = suppressibleFindingIds(this.clusters, 0.6);
    this.stats.suppressed = suppressed.size;

    for (const c of this.clusters) {
      if (c.symptoms.length === 0) continue;
      logger.info(
        `Incident ${c.id}: ${c.all.length} findings from ${c.agentsInvolved.length} agents ` +
          `on ${c.entity} -> probable cause "${c.rootCause.title}" ` +
          `(confidence ${c.confidence}${c.simulated ? ', includes simulated input' : ''})`,
      );
    }

    this.pushHistory();
    return { clusters: this.clusters, findings: findings.length, suppressed: suppressed.size };
  }

  pushHistory() {
    for (const c of this.clusters) {
      // Every incident is persisted, including one with a single finding. A
      // lone critical finding is still something an operator needs to look up
      // later: "has this happened before?" does not become a less useful
      // question just because nothing else correlated with it.
      this.store.saveIncident({
        id: c.id,
        entity: c.entity,
        severity: c.severity,
        rootCauseKind: c.rootCause.kind,
        rootCauseTitle: c.rootCause.title,
        findingCount: c.all.length,
        agents: c.agentsInvolved,
        confidence: c.confidence,
        simulated: c.simulated,
        startedAt: c.startedAt,
        lastActivityAt: c.lastActivityAt,
      });

      // The in-memory summary is a different thing: it is the "what is
      // currently interesting" list, so it keeps the multi-finding filter.
      if (c.symptoms.length === 0) continue;
      const existing = this.history.find((h) => h.id === c.id);
      if (existing) {
        existing.lastActivityAt = c.lastActivityAt;
        existing.findingCount = c.all.length;
        continue;
      }
      this.history.push({
        id: c.id,
        entity: c.entity,
        severity: c.severity,
        rootCause: c.rootCause.title,
        rootCauseKind: c.rootCause.kind,
        findingCount: c.all.length,
        agents: c.agentsInvolved,
        startedAt: c.startedAt,
        lastActivityAt: c.lastActivityAt,
        confidence: c.confidence,
        simulated: c.simulated,
      });
      if (this.history.length > this.historySize) this.history.shift();
    }
  }

  start() {
    if (this.timer) return;
    logger.info(`Starting deterministic correlation (every ${this.intervalMs / 1000}s)`);
    this.timer = setInterval(() => {
      this.run().catch((err) => logger.error(`Correlation run failed: ${err.message}`));
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Incidents recorded previously, newest first. */
  incidentHistory(limit = 50) {
    return this.store.recentIncidents(limit);
  }

  /** Current incidents, shaped for the API and for agent7 to enrich. */
  snapshot() {
    return {
      generatedAt: this.lastRunAt,
      stats: { ...this.stats, storage: this.store.stats() },
      incidents: this.clusters.map((c) => ({
        id: c.id,
        entity: c.entity,
        severity: c.severity,
        confidence: c.confidence,
        simulated: c.simulated,
        startedAt: c.startedAt,
        lastActivityAt: c.lastActivityAt,
        agentsInvolved: c.agentsInvolved,
        reasoning: c.reasoning,
        rootCause: {
          agent: c.rootCause.agent,
          kind: c.rootCause.kind,
          title: c.rootCause.title,
          severity: c.rootCause.severity,
        },
        symptoms: c.symptoms.map((s) => ({
          agent: s.agent,
          kind: s.kind,
          title: s.title,
          severity: s.severity,
        })),
      })),
    };
  }
}

module.exports = CorrelationEngine;
