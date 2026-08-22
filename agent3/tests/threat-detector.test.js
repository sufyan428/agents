const { test } = require('node:test');
const assert = require('node:assert');
const { FindingStore } = require('@ragent/agent-common');
const ThreatDetector = require('../src/modules/threat-detector');

const silent = { warn() {}, info() {}, debug() {} };
const make = (config = {}) => {
  const findings = new FindingStore();
  return {
    findings,
    d: new ThreatDetector({
      findingStore: findings,
      logger: silent,
      config: { time_window_seconds: 300, max_failed_attempts: 5, ...config },
    }),
  };
};

test('failures spread over hours are not an attack', () => {
  // The regression: a fixed count with no window treated five failures across
  // a working day exactly like five in two seconds.
  const { d, findings } = make();
  let t = Date.UTC(2026, 0, 1);
  for (let i = 0; i < 10; i++) {
    d.recordAuthFailure({ sourceIp: '10.0.0.5', router: 'R1', at: t });
    t += 30 * 60 * 1000; // half an hour apart
  }
  assert.equal(findings.activeCount, 0, 'ten failures over five hours is not a burst');
});

test('the same count inside the window is a brute force', () => {
  const { d, findings } = make();
  const t = Date.UTC(2026, 0, 1);
  for (let i = 0; i < 6; i++) {
    d.recordAuthFailure({
      sourceIp: '10.0.0.5',
      username: 'admin',
      router: 'R1',
      at: t + i * 1000,
    });
  }
  const f = findings.list().find((x) => x.kind === 'auth_failure_burst');
  assert.ok(f, 'should detect');
  assert.equal(f.severity, 'high');
  assert.equal(f.evidence.sourceIp, '10.0.0.5');
  assert.ok(f.evidence.failuresInWindow >= 5);
});

test('a very high rate escalates to critical', () => {
  const { d, findings } = make();
  const t = Date.UTC(2026, 0, 1);
  for (let i = 0; i < 25; i++) {
    d.recordAuthFailure({ sourceIp: '10.0.0.5', router: 'R1', at: t + i * 100 });
  }
  assert.equal(findings.list().find((x) => x.kind === 'auth_failure_burst').severity, 'critical');
});

test('password spraying is caught even though no single source crosses the threshold', () => {
  // The detection per-source thresholds are designed to miss: many sources,
  // each deliberately quiet.
  const { d, findings } = make({ max_failed_attempts: 5 });
  const t = Date.UTC(2026, 0, 1);
  for (let s = 0; s < 8; s++) {
    for (let i = 0; i < 2; i++) {
      d.recordAuthFailure({
        sourceIp: `10.0.1.${s}`,
        username: `user${s}`,
        router: 'R1',
        at: t + i * 1000,
      });
    }
  }
  assert.equal(
    findings.list().some((x) => x.kind === 'auth_failure_burst'),
    false,
    'no single source reached the threshold',
  );
  const spray = findings.list().find((x) => x.kind === 'auth_failure_distributed');
  assert.ok(spray, 'the pattern across sources is still detected');
  assert.ok(spray.evidence.distinctSources >= 5);
  assert.match(spray.detail, /password spraying/);
});

test('a busy client on one port is not a scan', () => {
  const { d, findings } = make();
  const t = Date.UTC(2026, 0, 1);
  for (let i = 0; i < 200; i++) {
    d.recordConnection({ sourceIp: '10.0.0.9', port: 443, router: 'R1', at: t + i });
  }
  assert.equal(findings.activeCount, 0, '200 connections to one port is normal traffic');
});

test('a few connections across many ports is a scan', () => {
  const { d, findings } = make({ port_scan_distinct_ports: 15 });
  const t = Date.UTC(2026, 0, 1);
  for (let p = 20; p < 40; p++) {
    d.recordConnection({ sourceIp: '10.0.0.9', port: p, router: 'R1', at: t + p });
  }
  const f = findings.list().find((x) => x.kind === 'port_scan');
  assert.ok(f);
  assert.ok(f.evidence.distinctPorts >= 15);
});

test('an ongoing attack produces one finding, not one per packet', () => {
  const { d, findings } = make();
  const t = Date.UTC(2026, 0, 1);
  for (let i = 0; i < 100; i++) {
    d.recordAuthFailure({ sourceIp: '10.0.0.5', router: 'R1', at: t + i * 100 });
  }
  assert.equal(findings.list().filter((x) => x.kind === 'auth_failure_burst').length, 1);
});

test('separate sources are tracked separately', () => {
  const { d } = make();
  const t = Date.UTC(2026, 0, 1);
  for (let i = 0; i < 6; i++)
    d.recordAuthFailure({ sourceIp: '10.0.0.1', router: 'R1', at: t + i * 100 });
  for (let i = 0; i < 2; i++)
    d.recordAuthFailure({ sourceIp: '10.0.0.2', router: 'R1', at: t + i * 100 });
  const stats = d.getStats();
  assert.ok(stats.trackedSources >= 2);
  assert.equal(stats.bruteForce, 1, 'only the noisy source triggered');
});

test('malformed input is ignored rather than throwing', () => {
  const { d } = make();
  assert.doesNotThrow(() => {
    d.recordAuthFailure({ sourceIp: '', router: 'R1' });
    d.recordConnection({ sourceIp: '10.0.0.1', port: NaN, router: 'R1' });
    d.recordConnection({ sourceIp: null, port: 80, router: 'R1' });
  });
});
