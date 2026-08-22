#!/usr/bin/env node
/**
 * Router simulator.
 *
 * Gives the framework something real to talk to: a real SNMP responder on a
 * real socket, real syslog over real UDP, and an HTTP control API for
 * injecting faults on demand.
 *
 * It exists for three reasons at once, which is why it earns its place:
 *
 *   1. The framework can be demonstrated by anyone, with no hardware.
 *   2. Code paths that previously fabricated data have something real to read.
 *   3. Faults that cannot be produced on demand against real hardware - an
 *      interface flap, a CPU spike, a burst of failed logins - become one
 *      repeatable HTTP call, which is what integration tests need.
 *
 * Usage:
 *   node src/index.js
 *   node src/index.js --snmp-port 1161 --api-port 8090
 *
 *   curl localhost:8090/state
 *   curl -X POST localhost:8090/fault/interface_flap
 *   curl -X POST localhost:8090/fault/cpu_spike -d '{"target":98}' -H 'content-type: application/json'
 *   curl -X POST localhost:8090/faults/clear
 */

const http = require('node:http');
const { Device } = require('./device');
const { SnmpAgent } = require('./snmp-agent');
const { FaultEngine, SyslogEmitter } = require('./faults');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, '');
    if (key) out[key] = argv[i + 1];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

const log = {
  info: (m) => console.log(`[router-sim] ${m}`),
  warn: (m) => console.warn(`[router-sim] WARN ${m}`),
  error: (m) => console.error(`[router-sim] ERROR ${m}`),
  debug: () => {},
};

const config = {
  snmpPort: Number(args['snmp-port'] || process.env.SIM_SNMP_PORT || 1161),
  apiPort: Number(args['api-port'] || process.env.SIM_API_PORT || 8090),
  community: args.community || process.env.SIM_COMMUNITY || 'public',
  syslogHost: args['syslog-host'] || process.env.SIM_SYSLOG_HOST || '127.0.0.1',
  syslogPorts: (args['syslog-ports'] || process.env.SIM_SYSLOG_PORTS || '5140,5142,5143,5144')
    .split(',')
    .map((p) => Number(p.trim()))
    .filter(Boolean),
  // Loopback by default, like everything else in this project. The simulator
  // has no authentication at all, so exposing it is a deliberate act.
  bindHost: args['bind-host'] || process.env.BIND_HOST || '127.0.0.1',
};

const device = new Device({ name: args.name || 'sim-router-1' });
const syslog = new SyslogEmitter({
  host: config.syslogHost,
  ports: config.syslogPorts,
  hostname: device.name,
  logger: log,
});
const faults = new FaultEngine(device, { logger: log, syslog });
const snmpAgent = new SnmpAgent(device, {
  port: config.snmpPort,
  community: config.community,
  logger: log,
});

// ---------------------------------------------------------------- control API

function json(res, code, body) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 64 * 1024) req.destroy();
    });
    req.on('end', () => {
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve({});
      }
    });
  });
}

const api = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;

  try {
    if (req.method === 'GET' && path === '/state') {
      return json(res, 200, device.snapshot());
    }
    if (req.method === 'GET' && (path === '/health' || path === '/')) {
      return json(res, 200, {
        status: 'healthy',
        simulator: true,
        device: device.name,
        snmpPort: config.snmpPort,
        syslogTargets: config.syslogPorts,
        activeFaults: Array.from(device.activeFaults.keys()),
      });
    }
    if (req.method === 'GET' && path === '/faults') {
      return json(res, 200, { faults: faults.list() });
    }
    if (req.method === 'POST' && path === '/faults/clear') {
      return json(res, 200, faults.clearAll());
    }
    if (req.method === 'POST' && path === '/reset') {
      faults.clearAll();
      device.reset();
      return json(res, 200, { reset: true });
    }
    if (req.method === 'POST' && path.startsWith('/fault/')) {
      const name = path.slice('/fault/'.length);
      const params = await readBody(req);
      return json(res, 200, faults.inject(name, params));
    }
    if (req.method === 'DELETE' && path.startsWith('/fault/')) {
      return json(res, 200, faults.clear(path.slice('/fault/'.length)));
    }
    if (req.method === 'POST' && path === '/syslog') {
      const body = await readBody(req);
      if (!body.message) return json(res, 400, { error: '"message" is required' });
      syslog.send(body.message, body.severity ?? 6);
      return json(res, 200, { sent: true });
    }
    return json(res, 404, { error: 'Not found', path });
  } catch (err) {
    return json(res, 400, { error: err.message });
  }
});

// ------------------------------------------------------------------- start up

function start() {
  snmpAgent.start();
  syslog.startHeartbeat();

  api.listen(config.apiPort, config.bindHost, () => {
    log.info(`control API on http://${config.bindHost}:${config.apiPort}`);
    log.info(`syslog -> ${config.syslogHost}:${config.syslogPorts.join(',')}`);
    log.info('');
    log.info('  point the framework at it with:');
    log.info(`    router.primary.host           127.0.0.1`);
    log.info(`    router.primary.snmp_port      ${config.snmpPort}`);
    log.info(`    router.primary.snmp_community ${config.community}`);
    log.info('');
    log.info(`  inject a fault:  curl -X POST localhost:${config.apiPort}/fault/interface_flap`);
    log.info(`  list faults:     curl localhost:${config.apiPort}/faults`);
  });

  const tick = setInterval(() => device.tick(), 1000);
  tick.unref?.();
}

function stop() {
  log.info('shutting down');
  faults.clearAll();
  snmpAgent.stop();
  syslog.stop();
  api.close();
  process.exitCode = 0;
}

process.on('SIGINT', stop);
process.on('SIGTERM', stop);

if (require.main === module) start();

module.exports = { device, faults, snmpAgent, syslog, api, start, stop, config };
