/**
 * Unit tests for processors module
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { thresholdProcessor } = require('../src/processors');

test('ThresholdProcessor should initialize', () => {
  assert.strictEqual(typeof thresholdProcessor, 'object');
  assert.strictEqual(typeof thresholdProcessor.processSNMPMetrics, 'function');
});

test('ThresholdProcessor should check CPU thresholds', () => {
  const testMetrics = {
    router: 'TestRouter',
    cpu: 95,
    memory: 50,
    temperature: 60,
  };

  const alerts = thresholdProcessor.processSNMPMetrics(testMetrics);
  assert.ok(Array.isArray(alerts));
});

test('ThresholdProcessor should check memory thresholds', () => {
  const testMetrics = {
    router: 'TestRouter',
    cpu: 50,
    memory: 92,
    temperature: 60,
  };

  const alerts = thresholdProcessor.processSNMPMetrics(testMetrics);
  assert.ok(Array.isArray(alerts));
});

test('ThresholdProcessor should check temperature thresholds', () => {
  const testMetrics = {
    router: 'TestRouter',
    cpu: 50,
    memory: 50,
    temperature: 88,
  };

  const alerts = thresholdProcessor.processSNMPMetrics(testMetrics);
  assert.ok(Array.isArray(alerts));
});

test('ThresholdProcessor should process bandwidth metrics', () => {
  const alerts = thresholdProcessor.processBandwidthMetrics('TestRouter', 'GigabitEthernet0/0', 90);
  assert.ok(Array.isArray(alerts));
});

test('ThresholdProcessor should process latency metrics', () => {
  const alerts = thresholdProcessor.processLatencyMetrics('TestRouter', '8.8.8.8', 250);
  assert.ok(Array.isArray(alerts));
});

test('ThresholdProcessor should process packet loss metrics', () => {
  const alerts = thresholdProcessor.processPacketLossMetrics('TestRouter', 6);
  assert.ok(Array.isArray(alerts));
});

test('ThresholdProcessor should process failed login metrics', () => {
  const alerts = thresholdProcessor.processFailedLogins('TestRouter', 12);
  assert.ok(Array.isArray(alerts));
});

test('ThresholdProcessor should process interface errors metrics', () => {
  const alerts = thresholdProcessor.processInterfaceErrors('TestRouter', 'GigabitEthernet0/0', 520);
  assert.ok(Array.isArray(alerts));
});

test('ThresholdProcessor should have unit helper', () => {
  const cpuUnit = thresholdProcessor.getUnit('cpu');
  assert.strictEqual(cpuUnit, '%');

  const tempUnit = thresholdProcessor.getUnit('temperature');
  assert.strictEqual(tempUnit, '°C');
});
