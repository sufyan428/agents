// Module-load smoke test - the referenced test file never actually existed
// (package.json pointed at it, but it was never created). This is a minimal
// but real check: every module the agent depends on must load without
// throwing (bad requires, syntax errors, top-level exceptions). It does not
// require a running server or real router hardware.
const test = require('node:test');
const assert = require('node:assert');

const modules = [
  '../config/configLoader',
  '../utils/logger',
  '../metrics/prometheusMetrics',
  '../modules/configSync',
  '../modules/failoverManager',
  '../modules/heartbeatChecker',
  '../modules/syslogListener',
  '../monitors/pingMonitor',
  '../monitors/snmpMonitor',
  '../server/expressServer'
];

for (const modPath of modules) {
  test(`module loads without throwing: ${modPath}`, () => {
    assert.doesNotThrow(() => require(modPath));
  });
}
