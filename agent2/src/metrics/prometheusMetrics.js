const promClient = require('prom-client');

class PrometheusMetrics {
  constructor(config) {
    this.config = config;
    this.register = new promClient.Registry();
    
    // Default metrics (Node.js process metrics)
    promClient.collectDefaultMetrics({ 
      register: this.register,
      prefix: 'resilience_agent_'
    });

    this.initializeMetrics();
  }

  initializeMetrics() {
    // Router health metrics
    this.routerPrimaryUp = new promClient.Gauge({
      name: 'router_primary_up',
      help: 'Whether the primary router is up (1 = up, 0 = down)',
      registers: [this.register]
    });

    this.routerBackupUp = new promClient.Gauge({
      name: 'router_backup_up',
      help: 'Whether the backup router is up (1 = up, 0 = down)',
      registers: [this.register]
    });

    // Router response time
    this.routerResponseTime = new promClient.Gauge({
      name: 'router_response_time_seconds',
      help: 'Router response time in seconds',
      labelNames: ['router', 'method'],
      registers: [this.register]
    });

    // Router uptime
    this.routerUptime = new promClient.Gauge({
      name: 'router_uptime_seconds',
      help: 'Router uptime in seconds',
      labelNames: ['router'],
      registers: [this.register]
    });

    // Failover events
    this.failoverEvents = new promClient.Counter({
      name: 'failover_events_total',
      help: 'Total number of failover events',
      labelNames: ['type', 'reason'],
      registers: [this.register]
    });

    this.failbackEvents = new promClient.Counter({
      name: 'failback_events_total',
      help: 'Total number of failback events',
      labelNames: ['reason'],
      registers: [this.register]
    });

    // Heartbeat metrics
    this.missedHeartbeats = new promClient.Counter({
      name: 'missed_heartbeats_total',
      help: 'Total number of missed heartbeats',
      labelNames: ['router'],
      registers: [this.register]
    });

    this.heartbeatSuccess = new promClient.Counter({
      name: 'heartbeat_success_total',
      help: 'Total number of successful heartbeats',
      labelNames: ['router', 'method'],
      registers: [this.register]
    });

    // Configuration sync metrics
    this.configSyncStatus = new promClient.Gauge({
      name: 'config_sync_status',
      help: 'Configuration synchronization status (1 = synced, 0 = out of sync)',
      registers: [this.register]
    });

    this.configSyncErrors = new promClient.Counter({
      name: 'config_sync_errors_total',
      help: 'Total number of configuration sync errors',
      labelNames: ['type'],
      registers: [this.register]
    });

    this.configSyncLastSuccess = new promClient.Gauge({
      name: 'config_sync_last_success_timestamp',
      help: 'Timestamp of last successful configuration sync',
      registers: [this.register]
    });

    // Active router indicator
    this.activeRouter = new promClient.Gauge({
      name: 'active_router',
      help: 'Currently active router (1 = primary, 2 = backup)',
      labelNames: ['host', 'type'],
      registers: [this.register]
    });

    // Agent health
    this.agentHealth = new promClient.Gauge({
      name: 'agent_health',
      help: 'Agent health status (1 = healthy, 0 = unhealthy)',
      registers: [this.register]
    });

    // SNMP query metrics
    this.snmpQueryDuration = new promClient.Histogram({
      name: 'snmp_query_duration_seconds',
      help: 'SNMP query duration in seconds',
      labelNames: ['router', 'oid'],
      buckets: [0.1, 0.5, 1, 2, 5, 10],
      registers: [this.register]
    });

    this.snmpQueryErrors = new promClient.Counter({
      name: 'snmp_query_errors_total',
      help: 'Total number of SNMP query errors',
      labelNames: ['router', 'error_type'],
      registers: [this.register]
    });

    // Ping metrics
    this.pingDuration = new promClient.Histogram({
      name: 'ping_duration_seconds',
      help: 'Ping duration in seconds',
      labelNames: ['router'],
      buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1],
      registers: [this.register]
    });

    this.pingPacketsLost = new promClient.Counter({
      name: 'ping_packets_lost_total',
      help: 'Total number of lost ping packets',
      labelNames: ['router'],
      registers: [this.register]
    });
  }

  updateRouterPrimaryStatus(isUp) {
    this.routerPrimaryUp.set(isUp ? 1 : 0);
  }

  updateRouterBackupStatus(isUp) {
    this.routerBackupUp.set(isUp ? 1 : 0);
  }

  updateResponseTime(router, method, time) {
    this.routerResponseTime.set({ router, method }, time);
  }

  updateUptime(router, uptime) {
    this.routerUptime.set({ router }, uptime);
  }

  recordFailover(type, reason) {
    this.failoverEvents.inc({ type, reason });
  }

  recordFailback(reason) {
    this.failbackEvents.inc({ reason });
  }

  recordMissedHeartbeat(router) {
    this.missedHeartbeats.inc({ router });
  }

  recordHeartbeatSuccess(router, method) {
    this.heartbeatSuccess.inc({ router, method });
  }

  updateConfigSyncStatus(status) {
    this.configSyncStatus.set(status ? 1 : 0);
  }

  recordConfigSyncError(type) {
    this.configSyncErrors.inc({ type });
  }

  updateConfigSyncLastSuccess(timestamp) {
    this.configSyncLastSuccess.set(timestamp);
  }

  setActiveRouter(host, type) {
    this.activeRouter.set({ host, type }, 1);
  }

  updateAgentHealth(isHealthy) {
    this.agentHealth.set(isHealthy ? 1 : 0);
  }

  recordSnmpQueryDuration(router, oid, duration) {
    this.snmpQueryDuration.observe({ router, oid }, duration);
  }

  recordSnmpQueryError(router, errorType) {
    this.snmpQueryErrors.inc({ router, error_type: errorType });
  }

  recordPingDuration(router, duration) {
    this.pingDuration.observe({ router }, duration);
  }

  recordPingPacketLoss(router) {
    this.pingPacketsLost.inc({ router });
  }

  async getMetrics() {
    return await this.register.metrics();
  }

  getContentType() {
    return this.register.contentType;
  }
}

module.exports = PrometheusMetrics;