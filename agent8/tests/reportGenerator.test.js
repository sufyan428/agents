const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ReportGenerator = require('../src/services/reportGenerator');

/**
 * agent8 had no tests at all until this file: its only test covered provider
 * resolution, which moved into @ragent/ai-core in Phase 6, and nothing replaced
 * it. A whole agent with zero coverage is not something to publish.
 */

function makeGenerator({ text = '# Digest\n\nAll quiet.', data = {} } = {}) {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a8-'));
  const calls = [];
  const config = {
    reports: { output_directory: outputDir },
    schedule: { history_size: 3 },
  };
  const llmClient = {
    async complete(system, user) {
      calls.push({ system, user });
      return text === null
        ? null
        : { text, usage: { inputTokens: 1, outputTokens: 2 }, model: 'fake' };
    },
  };
  const dataCollector = {
    async collect() {
      return { orchestratorOverview: { agents: {} }, agent5Reports: {}, ...data };
    },
  };
  const gen = new ReportGenerator(config, llmClient, dataCollector);
  // The constructor resolves output_directory relative to the agent, so point
  // it at the temp dir afterwards rather than fighting that.
  gen.outputDir = outputDir;
  return { gen, calls, outputDir };
}

test('a report is generated, written to disk and kept in history', async () => {
  const { gen, outputDir } = makeGenerator();
  const report = await gen.generate('digest');

  assert.ok(report, 'should produce a report');
  assert.match(report.markdown, /All quiet/);
  assert.equal(report.label, 'digest');
  assert.ok(fs.existsSync(path.join(outputDir, `${report.id}.md`)), 'written to disk');
  assert.equal(gen.getLatest().id, report.id);
});

test('history listings omit the report bodies', async () => {
  // Regression: the destructure that drops `markdown` was renamed to satisfy a
  // linter, which silently defeated it - so a listing of twenty reports
  // carried twenty full documents.
  const { gen } = makeGenerator({ text: '#'.repeat(5000) });
  await gen.generate('digest');
  const [entry] = gen.getHistory();
  assert.equal(entry.markdown, undefined, 'the body must not be in a listing');
  assert.ok(entry.id, 'but the metadata must be');
  assert.ok(entry.timestamp);
});

test('a model failure produces no report rather than an empty one', async () => {
  const { gen } = makeGenerator({ text: null });
  assert.equal(await gen.generate('digest'), null);
  assert.equal(gen.getHistory().length, 0, 'nothing is recorded');
});

test('unreachable sources are recorded on the report, not hidden', async () => {
  // A digest built from partial data must say so. Silently reporting on
  // whatever happened to be reachable is how a clean-looking summary ends up
  // describing half a system.
  const { gen } = makeGenerator({
    data: {
      orchestratorOverview: null,
      agent5Reports: { compliance: { error: 'connection refused' } },
    },
  });
  const report = await gen.generate('digest');
  assert.ok(report.sourceErrors.includes('orchestrator overview unreachable'));
  assert.ok(report.sourceErrors.some((e) => e.includes('compliance')));
});

test('history is bounded to the configured size', async () => {
  const { gen } = makeGenerator();
  for (let i = 0; i < 8; i++) await gen.generate(`d${i}`);
  assert.equal(gen.getHistory().length, 3, 'history_size is 3');
});

test('a report can be fetched by id, and an unknown id is null', async () => {
  const { gen } = makeGenerator();
  const report = await gen.generate('digest');
  assert.equal(gen.getById(report.id).id, report.id);
  assert.equal(gen.getById('does-not-exist'), null);
});

test('the collected data is what reaches the model', async () => {
  const { gen, calls } = makeGenerator({ data: { agent5Reports: { audit: { ok: true } } } });
  await gen.generate('digest');
  assert.equal(calls.length, 1);
  assert.match(calls[0].user, /agent5Reports/);
  assert.ok(calls[0].system.length > 0, 'a system prompt is sent');
});

test('getLatest is null before anything has been generated', () => {
  const { gen } = makeGenerator();
  assert.equal(gen.getLatest(), null);
  assert.deepEqual(gen.getHistory(), []);
});
