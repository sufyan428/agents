const logger = require('../utils/logger');

const SAFETY_NOTICE =
  'You are a remediation ADVISOR only. You never execute anything - every output ' +
  'you produce is a suggestion for a human operator to read, judge, and apply ' +
  'themselves. Never phrase output as if the action has already happened or will ' +
  'happen automatically. Always state a risk level and always include how to undo ' +
  'the change if it turns out to be wrong. If you are not confident a fix is safe, ' +
  'say so plainly instead of guessing.';

const SUGGEST_SYSTEM_PROMPT = `${SAFETY_NOTICE}

You will be given compliance violations (from the governance agent's policy checker) and/or a performance anomaly (a low efficiency score from the performance agent) for a router monitoring framework. Note: this often runs in a dev/test environment with no real router hardware reachable, so some "violations" or a low efficiency score may simply reflect that - call this out when it looks like the likely explanation rather than inventing a router-side cause.

For each real issue, provide:
1. A one-line diagnosis.
2. A suggested fix (specific, actionable).
3. Risk level: low / medium / high.
4. A rollback step if the fix doesn't help.

Be concise. If there's nothing worth suggesting, say so in one sentence.`;

const RUNBOOK_SYSTEM_PROMPT = `${SAFETY_NOTICE}

You will be given an incident description (either a cross-agent correlation finding, or a human-written description). Produce a numbered, step-by-step runbook a human on-call engineer could follow:
1. Numbered diagnostic/remediation steps, most likely cause first.
2. A rollback plan if the steps make things worse.
3. What to check afterward to confirm the fix worked.

Be concrete and concise - this is for someone acting under time pressure, not a report.`;

const REVIEW_SYSTEM_PROMPT = `${SAFETY_NOTICE}

You will be given a proposed configuration change for a router, plus whatever policy/baseline context is available. Assess:
1. Does this look safe, or could it cause an outage/security gap/compliance violation?
2. Verdict: safe / risky / needs-more-context.
3. Reasoning in 2-3 sentences.
4. If risky, what to change about the proposal to make it safer.

This is a pre-flight check before a human applies the change - you are not applying it.`;

class RemediationAdvisor {
  constructor(config, llmClient, dataCollector) {
    this.config = config;
    this.llmClient = llmClient;
    this.dataCollector = dataCollector;
    this.history = [];
  }

  async suggestRemediation() {
    const issues = await this.dataCollector.findIssues();

    if (!issues.hasIssues) {
      // Nothing worth spending an LLM call or a history slot on - log and move on,
      // rather than diluting the suggestion history with repeated "all clear" entries.
      logger.info('No compliance violations or performance anomalies detected - nothing to suggest');
      return { id: null, type: 'suggestion', timestamp: new Date().toISOString(), noIssuesFound: true };
    }

    const userContent = JSON.stringify(issues, null, 2);
    const result = await this.llmClient.analyze(SUGGEST_SYSTEM_PROMPT, userContent);

    if (!result || !result.text) {
      logger.error('Remediation suggestion generation returned no content');
      return null;
    }

    return this.record('suggestion', result.text, result.usage);
  }

  async generateRunbook(incidentDescription) {
    let description = incidentDescription;

    if (!description) {
      const latest = await this.dataCollector.getLatestIncident();
      description = latest.reachable && latest.data?.latest?.analysis
        ? latest.data.latest.analysis
        : null;
    }

    if (!description) {
      return null;
    }

    const result = await this.llmClient.analyze(RUNBOOK_SYSTEM_PROMPT, description);
    if (!result || !result.text) {
      logger.error('Runbook generation returned no content');
      return null;
    }

    return this.record('runbook', result.text, result.usage);
  }

  async reviewConfigChange(proposedChange) {
    const userContent = typeof proposedChange === 'string' ? proposedChange : JSON.stringify(proposedChange, null, 2);
    const result = await this.llmClient.analyze(REVIEW_SYSTEM_PROMPT, userContent);

    if (!result || !result.text) {
      logger.error('Config change review returned no content');
      return null;
    }

    return this.record('review', result.text, result.usage);
  }

  record(type, text, usage) {
    const entry = {
      id: `${type}-${Date.now()}`,
      type,
      timestamp: new Date().toISOString(),
      requiresHumanApproval: true,
      autoApply: false,
      text,
      usage
    };
    this.history.push(entry);
    const maxSize = this.config.polling.history_size;
    if (this.history.length > maxSize) {
      this.history.shift();
    }
    return entry;
  }

  getHistory() {
    return this.history;
  }

  getLatest() {
    return this.history[this.history.length - 1] || null;
  }
}

module.exports = RemediationAdvisor;
