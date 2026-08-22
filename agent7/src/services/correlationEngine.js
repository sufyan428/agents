const cron = require('node-cron');
const logger = require('../utils/logger');
const Collector = require('./collector');

/**
 * Narrates the incidents agent6 has already correlated.
 *
 * This agent used to compute its own correlation by handing a raw snapshot to
 * a model and asking what was related. That was wrong in two ways.
 *
 * It duplicated work the orchestrator now does deterministically, and worse, it
 * put the framework's ability to make sense of itself behind an API key - so
 * the system only became coherent once you paid for a model. The design premise
 * is the opposite.
 *
 * And a model asked to infer causation from a flat list has nothing to reason
 * from. It produces a plausible answer with no way to check it, which is the
 * least useful kind of answer in an incident.
 *
 * So agent6 does the correlation - grouping, root-cause ranking against a
 * stated causal layering, a confidence score - and this agent does what a model
 * is genuinely better at: turning that structure into something a human can
 * read at 3am, and saying what to look at first.
 *
 * If the model is unavailable, the incident is still there, still correlated,
 * still ranked. Only the prose is missing.
 */

const SYSTEM_PROMPT = `You are a network operations analyst writing for an on-call engineer who has just been paged.

You will be given an incident that has ALREADY been correlated deterministically by the framework's orchestrator. The grouping and the root-cause ranking are not yours to redo - they were derived from a stated dependency graph (device reachability -> link state -> protocol/failover -> device resources -> performance -> security -> policy) and the reasoning is included.

Your job is to make it readable and actionable:

1. One sentence saying what is happening, in plain language.
2. Why the identified root cause explains the other findings. If it does not fully explain them, say so - that is important information, not a failure.
3. The single most useful thing to check or do first.

Rules:
- Do not invent findings, devices, metrics or causes that are not in the input.
- If the input is marked as containing simulated data, state plainly that some of it did not come from a real device and should not be acted on as if it did.
- If the confidence score is low, say the grouping is uncertain rather than writing around it.
- No preamble, no headings, no restating the input. Under 120 words.`;

const QA_SYSTEM_PROMPT = `You are a network operations analyst answering an operator's direct question about a router monitoring framework.

You will be given the current incidents (already correlated by the orchestrator), a health snapshot of every agent, and the question.

Answer only from the data provided. If it does not cover what was asked, say so plainly rather than inferring. If any input is marked simulated, note that before drawing conclusions from it. Be brief and concrete.`;

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

    /**
     * Signature of the last incident set narrated.
     *
     * Without this the agent re-narrates an unchanged incident on every cycle -
     * the same prose, about the same problem, at the cost of a model call each
     * time. An unchanging incident is not new information.
     */
    this.lastNarratedSignature = null;

    this.metrics = {
      pollsTotal: 0,
      llmCallsTotal: 0,
      llmErrorsTotal: 0,
      narrationsSkipped: 0,
      lastPollAt: null,
      lastLlmCallAt: null,
    };
  }

  start() {
    const interval = this.config.correlation.poll_interval_seconds;
    const cronExpr = this.buildCronExpr(interval);
    logger.info(`Starting incident narration loop (every ${interval}s, cron: "${cronExpr}")`);
    this.cronTask = cron.schedule(cronExpr, () => this.tick());
  }

  // node-cron's seconds field only accepts 0-59, so an N-step there with N
  // over 59 silently collapses to matching only second 0 - correct for 60,
  // wrong for anything else. Step minutes instead.
  buildCronExpr(intervalSeconds) {
    if (intervalSeconds < 60) return `*/${intervalSeconds} * * * * *`;
    if (intervalSeconds % 60 === 0) return `0 */${intervalSeconds / 60} * * * *`;
    throw new Error(
      `correlation.poll_interval_seconds (${intervalSeconds}) must be under 60, or an exact multiple of 60`
    );
  }

  stop() {
    if (this.cronTask) this.cronTask.stop();
  }

  /**
   * Identity of an incident set.
   *
   * Deliberately excludes timestamps and occurrence counts: an incident that is
   * still happening is the same incident. Only a change in which findings are
   * involved, or in the identified cause, is worth new prose.
   */
  static signatureOf(incidents) {
    return incidents
      .map((i) => `${i.id}:${i.rootCause.kind}:${i.symptoms.length}:${i.severity}`)
      .sort()
      .join('|');
  }

  async tick() {
    if (this.running) {
      logger.warn('Previous narration tick still running, skipping this cycle');
      return;
    }
    this.running = true;

    try {
      const incidents = await this.collector.fetchIncidents();
      this.metrics.pollsTotal++;
      this.metrics.lastPollAt = new Date().toISOString();
      this.pollCount++;

      if (!incidents || incidents.length === 0) {
        this.latestResult = null;
        return;
      }

      // Only narrate incidents that actually have something to explain.
      const worthNarrating = incidents.filter((i) => i.symptoms.length > 0);
      if (worthNarrating.length === 0) return;

      const signature = CorrelationEngine.signatureOf(worthNarrating);
      if (signature === this.lastNarratedSignature) {
        this.metrics.narrationsSkipped++;
        logger.debug('Incident set unchanged since the last narration - skipping the model call');
        return;
      }

      const snapshot = await this.collector.collect();
      const userContent = JSON.stringify({ incidents: worthNarrating, agentHealth: snapshot.agents }, null, 2);

      this.metrics.llmCallsTotal++;
      this.metrics.lastLlmCallAt = new Date().toISOString();
      const result = await this.llmClient.complete(SYSTEM_PROMPT, userContent);

      if (result && result.text) {
        this.lastNarratedSignature = signature;
        this.latestResult = {
          timestamp: new Date().toISOString(),
          // The deterministic part is carried through verbatim, so a consumer
          // can always see what was computed versus what was written.
          incidents: worthNarrating.map((i) => ({
            id: i.id,
            entity: i.entity,
            severity: i.severity,
            confidence: i.confidence,
            rootCause: i.rootCause,
            symptomCount: i.symptoms.length,
            reasoning: i.reasoning,
            simulated: i.simulated,
          })),
          narrative: result.text,
          narratedBy: result.model,
          simulated: worthNarrating.some((i) => i.simulated),
          usage: result.usage,
        };
        logger.info(`Narrated ${worthNarrating.length} incident(s): ${result.text.slice(0, 160)}`);
      } else {
        this.metrics.llmErrorsTotal++;
        // The incidents remain available from agent6 regardless. Losing the
        // narration costs readability, not information.
        logger.warn('Narration unavailable; the correlated incidents are unaffected');
      }

      this.pushHistory(worthNarrating);
    } catch (error) {
      logger.error(`Narration tick failed: ${error.message}`);
    } finally {
      this.running = false;
    }
  }

  pushHistory(incidents) {
    this.history.push({ at: new Date().toISOString(), count: incidents.length });
    const maxSize = this.config.correlation.history_size;
    if (this.history.length > maxSize) this.history.shift();
  }

  /** Answers an operator's question over the current incidents and health. */
  async askQuestion(question) {
    const [incidents, snapshot] = await Promise.all([
      this.collector.fetchIncidents(),
      this.collector.collect(),
    ]);

    const userContent = JSON.stringify({
      question,
      incidents: incidents ?? [],
      agents: snapshot.agents,
      orchestratorReachable: snapshot.orchestratorReachable,
    }, null, 2);

    this.metrics.llmCallsTotal++;
    this.metrics.lastLlmCallAt = new Date().toISOString();
    return this.llmClient.complete(QA_SYSTEM_PROMPT, userContent);
  }

  getLatestSnapshot() { return this.history[this.history.length - 1] || null; }
  getHistory() { return this.history; }
  getLatestResult() { return this.latestResult; }
  getMetrics() {
    return { ...this.metrics, ...(this.llmClient?.stats ? { ai: this.llmClient.stats() } : {}) };
  }
}

module.exports = CorrelationEngine;
