const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

const SYSTEM_PROMPT = `You are a network operations reporting analyst for a router monitoring framework. You are given structured JSON pulled directly from the framework's own agents:
- agent5Reports: compliance, audit, configuration, and self-healing reports already computed by the governance agent
- orchestratorOverview: live running/healthy status of every agent in the framework
- agent7Incidents (may be null if that agent isn't running): recent cross-agent incident correlation findings

Turn this into a clear digest a human operator or manager would actually want to read. Write Markdown with:
1. A 2-3 sentence executive summary at the top.
2. Sections: Framework Health, Compliance, Security/Audit, Configuration, Self-Healing (skip a section if its source data errored out - say briefly that it was unavailable, don't fabricate content for it).
3. Plain language. Call out anything that needs attention. If everything is nominal, say so plainly rather than padding.

Do not invent data that isn't in the provided JSON.`;

class ReportGenerator {
  constructor(config, llmClient, dataCollector) {
    this.config = config;
    this.llmClient = llmClient;
    this.dataCollector = dataCollector;
    this.history = [];
    this.outputDir = path.resolve(
      path.join(__dirname, '..', '..'),
      config.reports.output_directory,
    );

    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true });
    }
  }

  async generate(label = 'digest') {
    const data = await this.dataCollector.collect();
    const userContent = JSON.stringify(data, null, 2);

    logger.info(`Generating ${label} report`);
    const result = await this.llmClient.complete(SYSTEM_PROMPT, userContent);

    if (!result || !result.text) {
      logger.error(`Report generation returned no content (${label})`);
      return null;
    }

    const report = {
      id: `${label}-${Date.now()}`,
      label,
      timestamp: new Date().toISOString(),
      markdown: result.text,
      usage: result.usage,
      sourceErrors: this.collectSourceErrors(data),
    };

    this.saveToDisk(report);
    this.pushHistory(report);

    logger.info(`Report generated: ${report.id}`);
    return report;
  }

  collectSourceErrors(data) {
    const errors = [];
    if (!data.orchestratorOverview) errors.push('orchestrator overview unreachable');
    for (const [type, value] of Object.entries(data.agent5Reports)) {
      if (value.error) errors.push(`agent5 ${type} report: ${value.error}`);
    }
    return errors;
  }

  saveToDisk(report) {
    const filePath = path.join(this.outputDir, `${report.id}.md`);
    fs.writeFileSync(filePath, report.markdown, 'utf8');
  }

  pushHistory(report) {
    this.history.push(report);
    const maxSize = this.config.schedule.history_size;
    if (this.history.length > maxSize) {
      this.history.shift();
    }
  }

  /**
   * Report metadata without the bodies.
   *
   * The destructure exists to DROP `markdown` - a listing of twenty reports
   * should not carry twenty full documents. eslint's ignoreRestSiblings option
   * covers this idiom; renaming the key to satisfy the rule silently defeats
   * the stripping, which is exactly what happened here once.
   */
  getHistory() {
    return this.history.map(({ markdown, ...meta }) => meta);
  }

  getLatest() {
    return this.history[this.history.length - 1] || null;
  }

  getById(id) {
    return this.history.find((r) => r.id === id) || null;
  }
}

module.exports = ReportGenerator;
