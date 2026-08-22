/**
 * Prometheus Metrics Module
 *
 * Provides Prometheus metrics for monitoring security events
 */

const promClient = require('prom-client');

class PrometheusMetrics {
  constructor(config) {
    this.config = config;
    this.register = new promClient.Registry();

    // Default metrics (CPU, memory, etc.)
    promClient.collectDefaultMetrics({
      register: this.register,
      prefix: 'security_agent_',
    });

    // Initialize custom metrics
    this.initializeMetrics();
  }

  initializeMetrics() {
    // Agent status
    this.agentStatus = new promClient.Gauge({
      name: 'security_agent_up',
      help: 'Indicates if the security agent is running (1 = up, 0 = down)',
      registers: [this.register],
    });

    // Authentication metrics
    this.failedLoginAttempts = new promClient.Counter({
      name: 'security_agent_failed_login_attempts_total',
      help: 'Total number of failed login attempts detected',
      labelNames: ['source_ip', 'username'],
      registers: [this.register],
    });

    this.successfulLoginAttempts = new promClient.Counter({
      name: 'security_agent_successful_login_attempts_total',
      help: 'Total number of successful login attempts',
      labelNames: ['source_ip', 'username'],
      registers: [this.register],
    });

    this.accountLockouts = new promClient.Counter({
      name: 'security_agent_account_lockouts_total',
      help: 'Total number of account lockouts triggered',
      labelNames: ['username', 'reason'],
      registers: [this.register],
    });

    // Traffic metrics
    this.trafficBytes = new promClient.Counter({
      name: 'security_agent_traffic_bytes_total',
      help: 'Total bytes of traffic analyzed',
      labelNames: ['protocol', 'direction'],
      registers: [this.register],
    });

    this.trafficPackets = new promClient.Counter({
      name: 'security_agent_traffic_packets_total',
      help: 'Total packets of traffic analyzed',
      labelNames: ['protocol', 'direction'],
      registers: [this.register],
    });

    this.trafficAnomalies = new promClient.Counter({
      name: 'security_agent_traffic_anomalies_total',
      help: 'Total number of traffic anomalies detected',
      labelNames: ['type', 'severity'],
      registers: [this.register],
    });

    // Configuration metrics
    this.configurationChanges = new promClient.Counter({
      name: 'security_agent_configuration_changes_total',
      help: 'Total number of configuration changes detected',
      labelNames: ['section', 'change_type', 'severity'],
      registers: [this.register],
    });

    this.configurationValidations = new promClient.Counter({
      name: 'security_agent_configuration_validations_total',
      help: 'Total number of configuration validations performed',
      labelNames: ['status'],
      registers: [this.register],
    });

    this.configurationDrift = new promClient.Gauge({
      name: 'security_agent_configuration_drift_score',
      help: 'Configuration drift score from golden baseline (0 = no drift)',
      labelNames: ['router'],
      registers: [this.register],
    });

    // Alert metrics
    this.alertsTotal = new promClient.Counter({
      name: 'security_agent_alerts_total',
      help: 'Total number of security alerts generated',
      labelNames: ['type', 'severity', 'source'],
      registers: [this.register],
    });

    this.alertsDispatched = new promClient.Counter({
      name: 'security_agent_alerts_dispatched_total',
      help: 'Total number of alerts dispatched to notification channels',
      labelNames: ['channel', 'status'],
      registers: [this.register],
    });

    // Protocol metrics
    this.syslogMessagesReceived = new promClient.Counter({
      name: 'security_agent_syslog_messages_total',
      help: 'Total number of syslog messages received',
      labelNames: ['facility', 'severity'],
      registers: [this.register],
    });

    this.snmpTrapsReceived = new promClient.Counter({
      name: 'security_agent_snmp_traps_total',
      help: 'Total number of SNMP traps received',
      labelNames: ['trap_type', 'severity'],
      registers: [this.register],
    });

    this.icmpPings = new promClient.Counter({
      name: 'security_agent_icmp_pings_total',
      help: 'Total number of ICMP pings sent',
      labelNames: ['status'],
      registers: [this.register],
    });

    this.icmpResponseTime = new promClient.Histogram({
      name: 'security_agent_icmp_response_time_seconds',
      help: 'ICMP ping response time in seconds',
      buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
      registers: [this.register],
    });

    // Threat detection metrics
    this.threatsDetected = new promClient.Counter({
      name: 'security_agent_threats_detected_total',
      help: 'Total number of threats detected',
      labelNames: ['threat_type', 'severity'],
      registers: [this.register],
    });

    this.aclViolations = new promClient.Counter({
      name: 'security_agent_acl_violations_total',
      help: 'Total number of ACL violations detected',
      labelNames: ['acl_name', 'source_ip', 'destination_port'],
      registers: [this.register],
    });

    this.portScans = new promClient.Counter({
      name: 'security_agent_port_scans_total',
      help: 'Total number of port scan attempts detected',
      labelNames: ['source_ip', 'scan_type'],
      registers: [this.register],
    });

    // Module health metrics
    this.moduleStatus = new promClient.Gauge({
      name: 'security_agent_module_status',
      help: 'Status of security agent modules (1 = healthy, 0 = unhealthy)',
      labelNames: ['module_name'],
      registers: [this.register],
    });

    // Performance metrics
    this.checkDuration = new promClient.Histogram({
      name: 'security_agent_check_duration_seconds',
      help: 'Duration of security checks in seconds',
      labelNames: ['check_type'],
      buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60],
      registers: [this.register],
    });

    this.queueSize = new promClient.Gauge({
      name: 'security_agent_queue_size',
      help: 'Current size of the processing queue',
      labelNames: ['queue_type'],
      registers: [this.register],
    });
  }

  /**
   * Increment failed login attempts counter
   */
  incrementFailedLogin(sourceIp, username) {
    this.failedLoginAttempts.inc({
      source_ip: sourceIp,
      username: username || 'unknown',
    });
  }

  /**
   * Increment successful login attempts counter
   */
  incrementSuccessfulLogin(sourceIp, username) {
    this.successfulLoginAttempts.inc({
      source_ip: sourceIp,
      username: username || 'unknown',
    });
  }

  /**
   * Record account lockout
   */
  recordAccountLockout(username, reason) {
    this.accountLockouts.inc({
      username: username || 'unknown',
      reason: reason || 'exceeded_attempts',
    });
  }

  /**
   * Record traffic data
   */
  recordTraffic(protocol, direction, bytes, packets) {
    this.trafficBytes.inc({ protocol, direction }, bytes);
    this.trafficPackets.inc({ protocol, direction }, packets);
  }

  /**
   * Record traffic anomaly
   */
  recordTrafficAnomaly(type, severity) {
    this.trafficAnomalies.inc({ type, severity });
  }

  /**
   * Record configuration change
   */
  recordConfigurationChange(section, changeType, severity) {
    this.configurationChanges.inc({
      section,
      change_type: changeType,
      severity,
    });
  }

  /**
   * Record configuration validation
   */
  recordConfigurationValidation(status) {
    this.configurationValidations.inc({ status });
  }

  /**
   * Update configuration drift score
   */
  updateConfigurationDrift(router, score) {
    this.configurationDrift.set({ router }, score);
  }

  /**
   * Record alert
   */
  recordAlert(type, severity, source) {
    this.alertsTotal.inc({ type, severity, source });
  }

  /**
   * Record alert dispatch
   */
  recordAlertDispatch(channel, status) {
    this.alertsDispatched.inc({ channel, status });
  }

  /**
   * Record syslog message
   */
  recordSyslogMessage(facility, severity) {
    this.syslogMessagesReceived.inc({ facility, severity });
  }

  /**
   * Record SNMP trap
   */
  recordSnmpTrap(trapType, severity) {
    this.snmpTrapsReceived.inc({ trap_type: trapType, severity });
  }

  /**
   * Record ICMP ping
   */
  recordIcmpPing(status) {
    this.icmpPings.inc({ status });
  }

  /**
   * Record ICMP response time
   */
  recordIcmpResponseTime(responseTime) {
    this.icmpResponseTime.observe(responseTime);
  }

  /**
   * Record detected threat
   */
  recordThreat(threatType, severity) {
    this.threatsDetected.inc({ threat_type: threatType, severity });
  }

  /**
   * Record ACL violation
   */
  recordAclViolation(aclName, sourceIp, destinationPort) {
    this.aclViolations.inc({
      acl_name: aclName,
      source_ip: sourceIp,
      destination_port: destinationPort,
    });
  }

  /**
   * Record port scan
   */
  recordPortScan(sourceIp, scanType) {
    this.portScans.inc({ source_ip: sourceIp, scan_type: scanType });
  }

  /**
   * Update module status
   */
  updateModuleStatus(moduleName, status) {
    this.moduleStatus.set({ module_name: moduleName }, status ? 1 : 0);
  }

  /**
   * Record check duration
   */
  recordCheckDuration(checkType, duration) {
    this.checkDuration.observe({ check_type: checkType }, duration);
  }

  /**
   * Update queue size
   */
  updateQueueSize(queueType, size) {
    this.queueSize.set({ queue_type: queueType }, size);
  }

  /**
   * Get metrics in Prometheus format
   */
  async getMetrics() {
    return await this.register.metrics();
  }

  /**
   * Reset all metrics (useful for testing)
   */
  resetMetrics() {
    this.register.resetMetrics();
  }
}

module.exports = PrometheusMetrics;
