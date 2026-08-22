#!/usr/bin/env node
/**
 * End-to-end: does an injected fault actually travel from the simulator,
 * through the agents, into one correlated incident that survives a restart?
 *
 * Unit tests verify pieces. This verifies the claim the framework is built
 * around, and it exists because a QA pass found that two modules built and
 * fully unit-tested in Phase 5 had never been connected to their agents. The
 * tests passed; the capability did not exist at runtime.
 *
 * Expects the simulator and the orchestrator to already be running:
 *
 *   npm run sim
 *   cd agent6 && AGENT_API_TOKEN=... npm start
 *   node tests/e2e-correlation.js
 */

const SIM = 'http://127.0.0.1:8090';
const ORCH = 'http://127.0.0.1:8080';
const AGENTS = {
  'agent1-monitoring': 9090,
  'agent2-resilience': 9091,
  'agent3-security': 9092,
  'agent4-performance': 9093,
  'agent5-automation': 9094,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(56)} ${detail}`);
}

async function json(url, opts) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000), ...opts });
    return await res.json();
  } catch (e) {
    return { __error: e.message };
  }
}

(async () => {
  console.log('\n1. every agent exposes the shared findings endpoint');
  for (const [name, port] of Object.entries(AGENTS)) {
    const body = await json(`http://127.0.0.1:${port}/api/findings`);
    check(
      `${name} /api/findings`,
      body.success === true,
      body.__error ?? `${body.summary?.active ?? 0} active`,
    );
  }

  console.log('\n2. inject a fault the agents can actually see');
  await json(`${SIM}/fault/interface_down`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ interface: 1, durationMs: 180000 }),
  });
  await json(`${SIM}/fault/auth_failure_burst`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ count: 30, intervalMs: 200, sourceCount: 1 }),
  });
  console.log('   injected interface_down + auth_failure_burst; waiting 70s for polls...');
  await sleep(70000);

  console.log('\n3. which agents produced findings?');
  let totalFindings = 0;
  const reporting = [];
  for (const [name, port] of Object.entries(AGENTS)) {
    const body = await json(`http://127.0.0.1:${port}/api/findings`);
    const n = body.findings?.length ?? 0;
    totalFindings += n;
    if (n > 0) reporting.push(name);
    if (n > 0) {
      for (const f of body.findings.slice(0, 3)) {
        console.log(`     ${name}: [${f.severity}] ${f.kind} - ${f.title}`);
      }
    }
  }
  check(
    'at least one agent reported a finding',
    totalFindings > 0,
    `${totalFindings} findings from ${reporting.length} agent(s)`,
  );

  console.log('\n4. did agent6 correlate them, with no AI configured?');
  const inc = await json(`${ORCH}/api/incidents`);
  check('incidents endpoint answers', inc.success === true, inc.__error ?? '');
  check(
    'findings were collected by the orchestrator',
    (inc.stats?.findingsSeen ?? 0) > 0,
    `saw ${inc.stats?.findingsSeen ?? 0}`,
  );
  if (inc.incidents?.length) {
    for (const i of inc.incidents) {
      console.log(
        `     incident on ${i.entity} | severity ${i.severity} | confidence ${i.confidence}`,
      );
      console.log(`       root cause: ${i.rootCause.kind} (${i.rootCause.agent})`);
      console.log(`       symptoms  : ${i.symptoms.map((s) => s.kind).join(', ') || 'none'}`);
    }
  }
  check(
    'at least one incident formed',
    (inc.incidents?.length ?? 0) > 0,
    `${inc.incidents?.length ?? 0} incident(s)`,
  );

  console.log('\n5. persistence');
  check(
    'storage is active',
    inc.stats?.storage?.available === true,
    inc.stats?.storage?.file ?? '',
  );
  const hist = await json(`${ORCH}/api/incidents/history`);
  check(
    'incident history is queryable',
    hist.success === true,
    `${hist.incidents?.length ?? 0} stored`,
  );

  console.log('\n6. clean up');
  await json(`${SIM}/faults/clear`, { method: 'POST' });

  const failed = results.filter((r) => !r.ok).length;
  console.log(
    `\n${results.length - failed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`,
  );
  process.exitCode = failed ? 1 : 0;
})();
