// Module-load smoke test - the referenced test file never actually existed
// (package.json pointed at it, but it was never created). This is a minimal
// but real check: every module the agent depends on must load without
// throwing (bad requires, syntax errors, top-level exceptions). It does not
// require a running server or real router hardware.
const test = require('node:test');
const assert = require('node:assert');

const modules = [
  '../src/utils/configLoader',
  '../src/utils/logger',
  '../src/utils/metrics',
  '../src/utils/snmpClient',
  '../src/utils/syslogListener',
  '../src/modules/auditReporter',
  '../src/modules/configManager',
  '../src/modules/policyChecker',
  '../src/modules/selfHealing',
  '../src/modules/taskScheduler'
];

for (const modPath of modules) {
  test(`module loads without throwing: ${modPath}`, () => {
    assert.doesNotThrow(() => require(modPath));
  });
}
