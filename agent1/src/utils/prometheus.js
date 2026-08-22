/**
 * Prometheus metrics exporter
 * Exposes metrics for Prometheus to scrape
 */

const client = require('prom-client');
const logger = require('./logger');

class PrometheusExporter {
  constructor() {
    this.register = new client.Registry();
    
    // Default metrics
    client.collectDefaultMetrics({ register: this.register });

    // Custom metrics for router monitoring
    this.metrics = {
      cpuUtilization: new client.Gauge({
        name: 'router_cpu_utilization_percent',
        help: 'Router CPU utilization percentage',
        labelNames: ['router', 'ip'],
        registers: [this.register]
      }),

      memoryUtilization: new client.Gauge({
        name: 'router_memory_utilization_percent',
        help: 'Router memory utilization percentage',
        labelNames: ['router', 'ip'],
        registers: [this.register]
      }),

      temperature: new client.Gauge({
        name: 'router_temperature_celsius',
        help: 'Router temperature in Celsius',
        labelNames: ['router', 'ip', 'sensor'],
        registers: [this.register]
      }),

      bandwidthIn: new client.Gauge({
        name: 'router_bandwidth_in_bytes',
        help: 'Router incoming bandwidth in bytes',
        labelNames: ['router', 'ip', 'interface'],
        registers: [this.register]
      }),

      bandwidthOut: new client.Gauge({
        name: 'router_bandwidth_out_bytes',
        help: 'Router outgoing bandwidth in bytes',
        labelNames: ['router', 'ip', 'interface'],
        registers: [this.register]
      }),

      latency: new client.Gauge({
        name: 'router_latency_milliseconds',
        help: 'Router latency in milliseconds',
        labelNames: ['router', 'ip', 'target'],
        registers: [this.register]
      }),

      packetLoss: new client.Gauge({
        name: 'router_packet_loss_percent',
        help: 'Router packet loss percentage',
        labelNames: ['router', 'ip'],
        registers: [this.register]
      }),

      interfaceErrors: new client.Counter({
        name: 'router_interface_errors_total',
        help: 'Total router interface errors',
        labelNames: ['router', 'ip', 'interface', 'direction'],
        registers: [this.register]
      }),

      failedLogins: new client.Counter({
        name: 'router_failed_logins_total',
        help: 'Total failed login attempts',
        // No `ip` label - see incrementFailedLogins for why.
        labelNames: ['router', 'known'],
        registers: [this.register]
      }),

      uptime: new client.Gauge({
        name: 'router_uptime_seconds',
        help: 'Router uptime in seconds',
        labelNames: ['router', 'ip'],
        registers: [this.register]
      }),

      alertsTriggered: new client.Counter({
        name: 'monitoring_alerts_triggered_total',
        help: 'Total monitoring alerts triggered',
        labelNames: ['router', 'severity', 'metric'],
        registers: [this.register]
      })
    };

    logger.info('Prometheus exporter initialized');
  }

  /**
   * Update CPU utilization metric
   */
  setCPU(routerName, ip, value) {
    this.metrics.cpuUtilization.set({ router: routerName, ip }, value);
  }

  /**
   * Update memory utilization metric
   */
  setMemory(routerName, ip, value) {
    this.metrics.memoryUtilization.set({ router: routerName, ip }, value);
  }

  /**
   * Update temperature metric
   */
  setTemperature(routerName, ip, sensor, value) {
    this.metrics.temperature.set({ router: routerName, ip, sensor }, value);
  }

  /**
   * Update bandwidth metrics
   */
  setBandwidth(routerName, ip, interfaceName, inBytes, outBytes) {
    this.metrics.bandwidthIn.set({ router: routerName, ip, interface: interfaceName }, inBytes);
    this.metrics.bandwidthOut.set({ router: routerName, ip, interface: interfaceName }, outBytes);
  }

  /**
   * Update latency metric
   */
  setLatency(routerName, ip, target, value) {
    this.metrics.latency.set({ router: routerName, ip, target }, value);
  }

  /**
   * Update packet loss metric
   */
  setPacketLoss(routerName, ip, value) {
    this.metrics.packetLoss.set({ router: routerName, ip }, value);
  }

  /**
   * Increment interface errors counter
   */
  incrementInterfaceErrors(routerName, ip, interfaceName, direction) {
    this.metrics.interfaceErrors.inc({ router: routerName, ip, interface: interfaceName, direction });
  }

  /**
   * Increment failed logins counter
   */
  /**
   * Counts a failed login.
   *
   * The source IP is deliberately NOT a label. It arrives from an
   * unauthenticated UDP syslog packet, so it is both attacker-controlled and
   * trivially spoofable - using it as a label meant anyone who could reach the
   * syslog port could mint unbounded time series and take down Prometheus.
   * Only `known` (whether the source matches a configured router) is recorded,
   * which is two series instead of 2^32. The addresses themselves are still in
   * the logs and in /status, where high cardinality costs nothing.
   */
  incrementFailedLogins(routerName, _ip) {
    const known = routerName && routerName !== 'unknown' ? 'true' : 'false';
    this.metrics.failedLogins.inc({ router: routerName || 'unknown', known });
  }

  /**
   * Update uptime metric
   */
  setUptime(routerName, ip, value) {
    this.metrics.uptime.set({ router: routerName, ip }, value);
  }

  /**
   * Increment alerts counter
   */
  incrementAlert(routerName, severity, metric) {
    this.metrics.alertsTriggered.inc({ router: routerName, severity, metric });
  }

  /**
   * Get metrics endpoint response
   */
  async getMetrics() {
    return await this.register.metrics();
  }

  /**
   * Get all metrics
   */
  getAllMetrics() {
    return this.metrics;
  }
}

module.exports = new PrometheusExporter();