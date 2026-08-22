/**
 * Unit tests for alerts module
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { alertManager } = require('../src/alerts');

test('AlertManager should initialize', () => {
  assert.strictEqual(typeof alertManager, 'object');
  assert.strictEqual(typeof alertManager.sendAlert, 'function');
});

test('AlertManager should send alert', async () => {
  const testAlert = {
    metric: 'cpu',
    severity: 'warning',
    router: 'TestRouter',
    value: 85,
    threshold: 75,
    timestamp: new Date().toISOString(),
    message: 'CPU usage warning',
    details: 'CPU usage above warning threshold',
  };

  const result = await alertManager.sendAlert(testAlert);
  // Just verify it doesn't throw an error
  assert.strictEqual(result, undefined);
});

test('AlertManager should track alert history', () => {
  // Send a test alert
  const testAlert = {
    metric: 'memory',
    severity: 'critical',
    router: 'TestRouter2',
    value: 95,
    threshold: 90,
    timestamp: new Date().toISOString(),
    message: 'Memory critical alert',
    details: 'Memory usage above critical threshold',
  };

  alertManager.sendAlert(testAlert);

  // Check if it's in history
  const history = alertManager.getAlertHistory(10);
  assert.ok(Array.isArray(history));
  assert.ok(history.length > 0);
});

test('AlertManager should provide alert statistics', () => {
  const stats = alertManager.getAlertStats();
  assert.ok(typeof stats, 'object');
  assert.ok(Object.prototype.hasOwnProperty.call(stats, 'total'));
  assert.ok(Object.prototype.hasOwnProperty.call(stats, 'bySeverity'));
  assert.ok(Object.prototype.hasOwnProperty.call(stats, 'byMetric'));
  assert.ok(Object.prototype.hasOwnProperty.call(stats, 'byRouter'));
});

test('AlertManager should clear history', () => {
  const _initialStats = alertManager.getAlertStats();
  alertManager.clearHistory();
  const clearedStats = alertManager.getAlertStats();

  assert.strictEqual(clearedStats.total, 0);
});

test('AlertManager should format email alerts', () => {
  const testAlert = {
    metric: 'temperature',
    severity: 'warning',
    router: 'TestRouter',
    value: 75,
    threshold: 70,
    timestamp: new Date().toISOString(),
    message: 'Temperature warning',
    details: 'Temperature above warning threshold',
  };

  const emailText = alertManager.formatAlertEmail(testAlert);
  assert.ok(emailText.includes('TestRouter'));
  assert.ok(emailText.includes('temperature'));
});

test('AlertManager should format HTML email alerts', () => {
  const testAlert = {
    metric: 'bandwidth',
    severity: 'critical',
    router: 'TestRouter',
    value: 95,
    threshold: 90,
    timestamp: new Date().toISOString(),
    message: 'Bandwidth critical',
    details: 'Bandwidth usage critical',
  };

  const emailHTML = alertManager.formatAlertHTMLEmail(testAlert);
  assert.ok(emailHTML.includes('TestRouter'));
  assert.ok(emailHTML.includes('bandwidth'));
  assert.ok(emailHTML.includes('<html>'));
});
