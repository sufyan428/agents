const promClient = require('prom-client');
const logger = require('./logger');

class Metrics {
  constructor(config) {
    this.config = config;

    // Enable default metrics
    if (this.config.metrics.enabled) {
      promClient.collectDefaultMetrics({
        timeout: 5000,
        gcDurationBuckets: [0.001, 0.01, 0.1, 1, 2, 5],
      });
    }

    // Initialize custom metrics
    this.initializeMetrics();
  }

  initializeMetrics() {
    // Governance metrics
    this.policiesChecked = new promClient.Counter({
      name: 'automation_governance_policies_checked_total',
      help: 'Total number of policies checked',
      labelNames: ['router', 'status'],
    });

    this.violationsDetected = new promClient.Counter({
      name: 'automation_governance_violations_detected_total',
      help: 'Total number of policy violations detected',
      labelNames: ['router', 'policy', 'severity'],
    });

    this.violationsFixed = new promClient.Counter({
      name: 'automation_governance_violations_fixed_total',
      help: 'Total number of policy violations fixed',
      labelNames: ['router', 'policy', 'method'],
    });

    // Configuration metrics
    this.configsBackedUp = new promClient.Counter({
      name: 'automation_governance_configs_backed_up_total',
      help: 'Total number of configuration backups performed',
      labelNames: ['router', 'status'],
    });

    this.configsPushed = new promClient.Counter({
      name: 'automation_governance_configs_pushed_total',
      help: 'Total number of configuration pushes performed',
      labelNames: ['router', 'change_type', 'status'],
    });

    this.configsRestored = new promClient.Counter({
      name: 'automation_governance_configs_restored_total',
      help: 'Total number of configuration restores performed',
      labelNames: ['router', 'status'],
    });

    // Self-healing metrics
    this.healingAttempts = new promClient.Counter({
      name: 'automation_governance_healing_attempts_total',
      help: 'Total number of self-healing attempts',
      labelNames: ['router', 'violation_type', 'status'],
    });

    this.healingSuccessRate = new promClient.Gauge({
      name: 'automation_governance_healing_success_rate',
      help: 'Self-healing success rate percentage',
      labelNames: ['router'],
    });

    // Task scheduling metrics
    this.tasksExecuted = new promClient.Counter({
      name: 'automation_governance_tasks_executed_total',
      help: 'Total number of scheduled tasks executed',
      labelNames: ['task_name', 'status'],
    });

    this.taskDuration = new promClient.Histogram({
      name: 'automation_governance_task_duration_seconds',
      help: 'Duration of task execution in seconds',
      labelNames: ['task_name'],
      buckets: [0.1, 0.5, 1, 5, 10, 30, 60, 300],
    });

    // Compliance metrics
    this.complianceScore = new promClient.Gauge({
      name: 'automation_governance_compliance_score',
      help: 'Compliance score percentage per router',
      labelNames: ['router'],
    });

    this.violationsBySeverity = new promClient.Gauge({
      name: 'automation_governance_violations_by_severity',
      help: 'Number of violations by severity level',
      labelNames: ['router', 'severity'],
    });

    // Audit metrics
    this.auditEventsLogged = new promClient.Counter({
      name: 'automation_governance_audit_events_total',
      help: 'Total number of audit events logged',
      labelNames: ['event_type', 'severity'],
    });

    this.reportsGenerated = new promClient.Counter({
      name: 'automation_governance_reports_generated_total',
      help: 'Total number of reports generated',
      labelNames: ['report_type'],
    });

    // SNMP metrics
    this.snmpRequests = new promClient.Counter({
      name: 'automation_governance_snmp_requests_total',
      help: 'Total number of SNMP requests',
      labelNames: ['router', 'operation', 'status'],
    });

    this.snmpResponseTime = new promClient.Histogram({
      name: 'automation_governance_snmp_response_time_seconds',
      help: 'SNMP request response time in seconds',
      labelNames: ['router', 'operation'],
      buckets: [0.01, 0.05, 0.1, 0.5, 1, 5],
    });

    // Syslog metrics
    this.syslogMessagesReceived = new promClient.Counter({
      name: 'automation_governance_syslog_messages_total',
      help: 'Total number of syslog messages received',
      labelNames: ['source', 'severity'],
    });

    // Router connection metrics
    this.routerConnectionStatus = new promClient.Gauge({
      name: 'automation_governance_router_connection_status',
      help: 'Router connection status (1 = connected, 0 = disconnected)',
      labelNames: ['router', 'host', 'protocol'],
    });

    this.routerLastSeen = new promClient.Gauge({
      name: 'automation_governance_router_last_seen_timestamp',
      help: 'Unix timestamp of last successful communication with router',
      labelNames: ['router', 'host'],
    });

    logger.info('Prometheus metrics initialized');
  }

  // Policy checking metrics
  recordPolicyCheck(router, status) {
    this.policiesChecked.inc({ router, status });
  }

  recordViolation(router, policy, severity) {
    this.violationsDetected.inc({ router, policy, severity });
  }

  recordViolationFixed(router, policy, method) {
    this.violationsFixed.inc({ router, policy, method });
  }

  // Configuration metrics
  recordConfigBackup(router, status) {
    this.configsBackedUp.inc({ router, status });
  }

  recordConfigPush(router, changeType, status) {
    this.configsPushed.inc({ router, change_type: changeType, status });
  }

  recordConfigRestore(router, status) {
    this.configsRestored.inc({ router, status });
  }

  // Self-healing metrics
  recordHealingAttempt(router, violationType, status) {
    this.healingAttempts.inc({ router, violation_type: violationType, status });
  }

  setHealingSuccessRate(router, rate) {
    this.healingSuccessRate.set({ router }, rate);
  }

  // Task scheduling metrics
  recordTaskExecution(taskName, status, duration) {
    this.tasksExecuted.inc({ task_name: taskName, status });
    this.taskDuration.observe({ task_name: taskName }, duration);
  }

  // Compliance metrics
  setComplianceScore(router, score) {
    this.complianceScore.set({ router }, score);
  }

  setViolationsBySeverity(router, severity, count) {
    this.violationsBySeverity.set({ router, severity }, count);
  }

  // Audit metrics
  recordAuditEvent(eventType, severity) {
    this.auditEventsLogged.inc({ event_type: eventType, severity });
  }

  recordReportGenerated(reportType) {
    this.reportsGenerated.inc({ report_type: reportType });
  }

  // SNMP metrics
  recordSnmpRequest(router, operation, status, duration) {
    this.snmpRequests.inc({ router, operation, status });
    this.snmpResponseTime.observe({ router, operation }, duration);
  }

  // Syslog metrics
  recordSyslogMessage(source, severity) {
    this.syslogMessagesReceived.inc({ source, severity });
  }

  // Router connection metrics
  setRouterConnectionStatus(router, host, protocol, status) {
    this.routerConnectionStatus.set({ router, host, protocol }, status);
  }

  setRouterLastSeen(router, host, timestamp) {
    this.routerLastSeen.set({ router, host }, timestamp);
  }

  // Get metrics for Prometheus
  async getMetrics() {
    return await promClient.register.metrics();
  }

  // Get metrics as string
  getMetricsAsString() {
    return promClient.register.metrics();
  }

  // Clear all metrics (useful for testing)
  clearMetrics() {
    promClient.register.clear();
    this.initializeMetrics();
  }

  // Get gauge values programmatically
  getGaugeValue(metric, labels) {
    return metric.get(labels);
  }

  // Get counter values programmatically
  getCounterValue(metric, labels) {
    return metric.get(labels);
  }
}

module.exports = Metrics;
