const yaml = require('js-yaml');
const fs = require('fs');
const path = require('path');
const winston = require('winston');
const {
  createServer,
  simulationHealthCheck,
  FindingStore,
  mountFindingsRoute,
} = require('@ragent/agent-common');
const QualityAnalyzer = require('./modules/quality-analyzer');
const promClient = require('prom-client');

// Import modules
const SnmpMonitor = require('./modules/snmp-monitor');
const IcmpTracker = require('./modules/icmp-tracker');
const SyslogListener = require('./modules/syslog-listener');
const QosMonitor = require('./modules/qos-monitor');
const TrafficBalancer = require('./modules/traffic-balancer');
const OptimizationEngine = require('./modules/optimization-engine');

// Normalized findings for agent6 to correlate, and the link-quality analysis
// that turns raw probes into percentiles, RFC 3550 jitter and burst-aware loss.
const findings = new FindingStore({ resolveAfterMs: 10 * 60 * 1000 });
let qualityAnalyzer = null;

// Load configuration
// Resolved against this file, not the working directory. Launched from
// anywhere else - which the orchestrator does - the relative path failed.
const config = yaml.load(fs.readFileSync(path.join(__dirname, 'router.yml'), 'utf8'));

// Initialize logger
const logger = winston.createLogger({
  level: config.agent.log_level,
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(winston.format.colorize(), winston.format.simple()),
    }),
    new winston.transports.File({
      filename: config.agent.log_file || 'logs/agent.log',
      maxsize: 10485760, // 10MB
      maxFiles: 5,
    }),
  ],
});

// Create logs directory if it doesn't exist
const logsDir = path.dirname(config.agent.log_file || 'logs/agent.log');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

// Initialize Prometheus metrics
const register = new promClient.Registry();
promClient.collectDefaultMetrics({ register });

// Custom metrics
const cpuUsageGauge = new promClient.Gauge({
  name: 'router_cpu_usage_percent',
  help: 'Router CPU usage percentage',
  registers: [register],
});

const memoryUsageGauge = new promClient.Gauge({
  name: 'router_memory_usage_percent',
  help: 'Router memory usage percentage',
  registers: [register],
});

const latencyGauge = new promClient.Gauge({
  name: 'router_latency_ms',
  help: 'Current network latency in milliseconds',
  labelNames: ['destination'],
  registers: [register],
});

const jitterGauge = new promClient.Gauge({
  name: 'router_jitter_ms',
  help: 'Network jitter in milliseconds',
  labelNames: ['destination'],
  registers: [register],
});

const packetLossGauge = new promClient.Gauge({
  name: 'router_packet_loss_percent',
  help: 'Packet loss percentage',
  labelNames: ['destination'],
  registers: [register],
});

const qosViolationGauge = new promClient.Gauge({
  name: 'router_qos_violations',
  help: 'Number of QoS policy violations',
  labelNames: ['class'],
  registers: [register],
});

const trafficImbalanceGauge = new promClient.Gauge({
  name: 'router_traffic_imbalance_percent',
  help: 'Traffic imbalance percentage across interfaces',
  registers: [register],
});

const optimizationTriggeredCounter = new promClient.Counter({
  name: 'router_optimizations_triggered',
  help: 'Number of optimization actions triggered',
  labelNames: ['type'],
  registers: [register],
});

const optimizationAppliedCounter = new promClient.Counter({
  name: 'router_optimizations_applied',
  help: 'Number of optimizations successfully applied',
  labelNames: ['type'],
  registers: [register],
});

const efficiencyScoreGauge = new promClient.Gauge({
  name: 'router_efficiency_score',
  help: 'Overall router efficiency score (0-100)',
  registers: [register],
});

// Initialize modules
const snmpMonitor = new SnmpMonitor(config, logger);
const icmpTracker = new IcmpTracker(config, logger);
const syslogListener = new SyslogListener(config, logger);
const qosMonitor = new QosMonitor(config, logger);
const trafficBalancer = new TrafficBalancer(config, logger);
const optimizationEngine = new OptimizationEngine(config, logger);

// Store current metrics
let currentMetrics = {
  cpu: 0,
  memory: 0,
  latency: {},
  jitter: {},
  packetLoss: {},
  qosViolations: {},
  trafficImbalance: 0,
  efficiencyScore: 100,
};

// Update Prometheus metrics
function updatePrometheusMetrics() {
  cpuUsageGauge.set(currentMetrics.cpu);
  memoryUsageGauge.set(currentMetrics.memory);
  trafficImbalanceGauge.set(currentMetrics.trafficImbalance);
  efficiencyScoreGauge.set(currentMetrics.efficiencyScore);

  // Update latency, jitter, and packet loss for each destination
  for (const [dest, value] of Object.entries(currentMetrics.latency)) {
    latencyGauge.set({ destination: dest }, value);
  }

  for (const [dest, value] of Object.entries(currentMetrics.jitter)) {
    jitterGauge.set({ destination: dest }, value);
  }

  for (const [dest, value] of Object.entries(currentMetrics.packetLoss)) {
    packetLossGauge.set({ destination: dest }, value);
  }

  // Update QoS violations
  for (const [cls, count] of Object.entries(currentMetrics.qosViolations)) {
    qosViolationGauge.set({ class: cls }, count);
  }
}

// Calculate efficiency score
function calculateEfficiencyScore(metrics) {
  const cpuScore = Math.max(0, 100 - metrics.cpu);
  const memoryScore = Math.max(0, 100 - metrics.memory);

  const avgLatency =
    Object.values(metrics.latency).reduce((a, b) => a + b, 0) /
    (Object.keys(metrics.latency).length || 1);
  const latencyScore = Math.max(0, 100 - avgLatency);

  const imbalancePenalty = metrics.trafficImbalance * 2;
  const qosViolationCount = Object.values(metrics.qosViolations).reduce((a, b) => a + b, 0);
  const qosPenalty = qosViolationCount * 5;

  const score =
    cpuScore * 0.3 +
    memoryScore * 0.2 +
    latencyScore * 0.3 +
    imbalancePenalty * -0.1 +
    qosPenalty * -0.1;

  return Math.max(0, Math.min(100, score));
}

// Main monitoring loop
async function monitorAndOptimize() {
  try {
    logger.info('Starting monitoring cycle...');

    // Collect metrics from all modules
    const snmpMetrics = await snmpMonitor.collectMetrics();
    const icmpMetrics = await icmpTracker.collectMetrics();
    const qosMetrics = await qosMonitor.collectMetrics();
    const trafficMetrics = await trafficBalancer.analyzeTraffic();

    // Update current metrics
    currentMetrics = {
      cpu: snmpMetrics.cpuUsage || 0,
      memory: snmpMetrics.memoryUsage || 0,
      latency: icmpMetrics.latency || {},
      jitter: icmpMetrics.jitter || {},
      packetLoss: icmpMetrics.packetLoss || {},
      qosViolations: qosMetrics.violations || {},
      trafficImbalance: trafficMetrics.imbalance || 0,
    };

    // Feed every probe into the quality analyzer, then let it decide whether
    // anything is worth reporting. This is what turns raw samples into
    // percentiles, RFC 3550 jitter and burst-aware loss - a mean hides the
    // tail that users actually notice.
    if (!qualityAnalyzer) {
      qualityAnalyzer = new QualityAnalyzer({
        findingStore: findings,
        logger,
        thresholds: {
          p95LatencyMs: config.optimization?.threshold_latency ?? 150,
          jitterMs: config.optimization?.threshold_jitter ?? 30,
        },
      });
    }

    for (const dest of icmpMetrics.destinations || []) {
      const lost = (icmpMetrics.packetLoss?.[dest] ?? 0) >= 100;
      qualityAnalyzer.recordProbe(dest, {
        latencyMs: lost ? null : icmpMetrics.latency?.[dest],
        lost,
      });
      qualityAnalyzer.evaluate(dest, config.router.host);
    }

    // Interface utilisation feeds the saturation forecast.
    for (const iface of snmpMetrics.interfaces || []) {
      if (Number.isFinite(iface.utilisation)) {
        qualityAnalyzer.recordUtilisation(config.router.host, iface.name, iface.utilisation);
        qualityAnalyzer.evaluateSaturation(config.router.host, iface.name);
      }
    }

    // Resolve findings whose condition has stopped recurring, so an operator
    // sees an incident end rather than only ever seeing it begin.
    for (const r of findings.sweep()) {
      logger.info(`Finding resolved: ${r.finding.title} after ${Math.round(r.durationMs / 1000)}s`);
    }

    // Calculate efficiency score
    currentMetrics.efficiencyScore = calculateEfficiencyScore(currentMetrics);

    logger.info(`Current efficiency score: ${currentMetrics.efficiencyScore.toFixed(2)}`);
    logger.info(`CPU: ${currentMetrics.cpu}%, Memory: ${currentMetrics.memory}%`);
    logger.info(`Traffic imbalance: ${currentMetrics.trafficImbalance}%`);

    // Update Prometheus metrics
    updatePrometheusMetrics();

    // Check if optimization is needed
    if (config.optimization.enabled) {
      const optimizationNeeded = await optimizationEngine.analyze(currentMetrics);

      if (optimizationNeeded.length > 0) {
        logger.warn(`Optimization needed: ${JSON.stringify(optimizationNeeded)}`);

        // Trigger optimizations
        for (const opt of optimizationNeeded) {
          optimizationTriggeredCounter.inc({ type: opt.type });

          if (config.optimization.auto_apply) {
            logger.info(`Auto-applying optimization: ${opt.type}`);
            const applied = await optimizationEngine.applyOptimization(opt);

            if (applied) {
              optimizationAppliedCounter.inc({ type: opt.type });
              logger.info(`Optimization ${opt.type} applied successfully`);
            } else {
              logger.error(`Failed to apply optimization: ${opt.type}`);
            }
          } else {
            logger.info(`Optimization recommended: ${opt.type} - ${opt.description}`);
          }
        }
      }
    }
  } catch (error) {
    logger.error(`Error in monitoring cycle: ${error.message}`);
  }
}

// HTTP server, via the shared factory: loopback binding, auth on mutating
// routes, rate limits, and an error handler that does not leak internals.
const bindHost = process.env.BIND_HOST || config.agent.bind_host || '127.0.0.1';
const agentServer = createServer({
  agent: 'agent4-performance',
  logger,
  port: Number(process.env.PORT) || config.agent.metrics_port,
  host: bindHost,
  authToken: (process.env.AGENT_API_TOKEN || '').trim() || undefined,
  corsOrigins: (process.env.AGENT_CORS_ORIGINS || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),
  healthChecks: () => [
    simulationHealthCheck('agent4'),
    {
      name: 'optimization_engine',
      status: 'healthy',
      message: `efficiency score ${currentMetrics.efficiencyScore}`,
      simulated: false,
    },
  ],
});

const app = agentServer.app;
mountFindingsRoute(app, findings, 'agent4-performance');

// The performance registry sits alongside the factory's process metrics.
app.get('/metrics/performance', async (req, res, next) => {
  try {
    res.set('Content-Type', register.contentType);
    res.end(await register.metrics());
  } catch (error) {
    next(error);
  }
});

agentServer
  .listen()
  .then(() => {
    logger.info('Performance Optimization Agent started');
  })
  .catch((error) => {
    logger.error(`Failed to start HTTP server: ${error.message}`);
    process.exit(1);
  });

// Start modules
async function startModules() {
  try {
    // Start syslog listener
    if (config.syslog.enabled) {
      await syslogListener.start();
      logger.info('Syslog listener started');
    }

    // Initial metrics collection
    await monitorAndOptimize();

    // Set up periodic monitoring
    setInterval(monitorAndOptimize, config.optimization.check_interval || 30000);

    logger.info(`Monitoring interval set to ${config.optimization.check_interval}ms`);
  } catch (error) {
    logger.error(`Error starting modules: ${error.message}`);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGINT', () => {
  logger.info('Shutting down Performance Optimization Agent...');
  syslogListener.stop();
  process.exit(0);
});

process.on('SIGTERM', () => {
  logger.info('Shutting down Performance Optimization Agent...');
  syslogListener.stop();
  process.exit(0);
});

// Start the agent
startModules();
