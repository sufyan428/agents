/**
 * Unit tests for collectors module
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { snmpCollector, syslogCollector } = require('../src/collectors');
// Note: there is no NetFlow collector in this agent (SNMP + Syslog only) -
// tests for one were removed rather than stubbed, since it was never built.

test('SNMPCollector should initialize', () => {
  // Test that the collector exists and has required methods
  assert.strictEqual(typeof snmpCollector.initialize, 'function');
  assert.strictEqual(typeof snmpCollector.collect, 'function');
  assert.strictEqual(typeof snmpCollector.collectAll, 'function');
});

test('SNMPCollector should have close method', () => {
  assert.strictEqual(typeof snmpCollector.close, 'function');
});

test('SyslogCollector should initialize', () => {
  assert.strictEqual(typeof syslogCollector.initialize, 'function');
  assert.strictEqual(typeof syslogCollector.getStats, 'function');
  assert.strictEqual(typeof syslogCollector.getRecentEvents, 'function');
});

test('SyslogCollector should have close method', () => {
  assert.strictEqual(typeof syslogCollector.close, 'function');
});

test('SyslogCollector should detect failed logins', () => {
  const testMessage = 'Failed password for root from 192.168.1.100';
  const result = syslogCollector.isFailedLogin(testMessage);
  assert.strictEqual(result, true);
});

test('SyslogCollector should detect security events', () => {
  const testMessage = 'Security breach detected on port 22';
  const result = syslogCollector.isSecurityEvent(testMessage);
  assert.strictEqual(result, true);
});