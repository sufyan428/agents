const dgram = require('node:dgram');

/**
 * Fault injection.
 *
 * This is the reason the simulator is worth more than a real router for
 * testing. You cannot ask your production switch to flap an interface, spike
 * its CPU, or emit forty failed logins because you would like to check an
 * alert fires. Here each of those is one HTTP call, repeatable, and it stops
 * cleanly afterwards.
 *
 * Every fault is reversible and self-limiting: it records what it changed and
 * restores it when the duration expires, so a scenario cannot leave the device
 * in a state that quietly poisons the next test.
 */

const FAULTS = {
  interface_flap: {
    describe: 'Takes an interface down and brings it back, repeatedly.',
    params: { interface: 1, downMs: 5000, upMs: 5000, cycles: 3 },
  },
  interface_down: {
    describe: 'Holds an interface down for the duration.',
    params: { interface: 1, durationMs: 60000 },
  },
  cpu_spike: {
    describe: 'Pins CPU at a target percentage.',
    params: { target: 95, durationMs: 120000 },
  },
  memory_leak: {
    describe: 'Climbs memory use steadily until it is cleared.',
    params: { ratePctPerSec: 0.5, durationMs: 300000 },
  },
  interface_errors: {
    describe: 'Adds input errors to an interface at a steady rate.',
    params: { interface: 1, errorsPerSec: 25, durationMs: 60000 },
  },
  traffic_surge: {
    describe: 'Multiplies interface load, driving bandwidth utilisation up.',
    params: { interface: 1, factor: 5, durationMs: 90000 },
  },
  auth_failure_burst: {
    describe: 'Emits a burst of failed-login syslog messages from random sources.',
    params: { count: 40, intervalMs: 250, sourceCount: 3 },
  },
  total_loss: {
    describe: 'The device stops answering SNMP and ICMP entirely.',
    params: { durationMs: 60000 },
  },
};

class FaultEngine {
  constructor(device, { logger = console, syslog = null } = {}) {
    this.device = device;
    this.logger = logger;
    this.syslog = syslog;
    /** name -> { timers: [], restore: fn } */
    this.running = new Map();
  }

  list() {
    return Object.entries(FAULTS).map(([name, f]) => ({
      name,
      description: f.describe,
      params: f.params,
      active: this.running.has(name),
    }));
  }

  /** Starts a fault. Restarting a running fault clears the previous one first. */
  inject(name, params = {}) {
    const spec = FAULTS[name];
    if (!spec) throw new Error(`Unknown fault "${name}". Known: ${Object.keys(FAULTS).join(', ')}`);

    if (this.running.has(name)) this.clear(name);
    const p = { ...spec.params, ...params };

    this.logger.info(`Injecting fault: ${name} ${JSON.stringify(p)}`);
    const handle = { timers: [], restore: () => {} };
    this.running.set(name, handle);
    this.device.activeFaults.set(name, p);

    const later = (fn, ms) => {
      const t = setTimeout(fn, ms);
      t.unref?.();
      handle.timers.push(t);
      return t;
    };
    const every = (fn, ms) => {
      const t = setInterval(fn, ms);
      t.unref?.();
      handle.timers.push(t);
      return t;
    };

    switch (name) {
      case 'interface_flap': {
        const iface = this.device.interfaceByIndex(p.interface);
        if (!iface) throw new Error(`No interface with index ${p.interface}`);
        handle.restore = () => { iface.operUp = true; };
        let cycle = 0;
        const flap = () => {
          if (cycle >= p.cycles) { this.clear(name); return; }
          cycle += 1;
          iface.operUp = false;
          this.emitSyslog(`%LINK-3-UPDOWN: Interface ${iface.name}, changed state to down`, 3);
          later(() => {
            iface.operUp = true;
            this.emitSyslog(`%LINK-3-UPDOWN: Interface ${iface.name}, changed state to up`, 5);
            later(flap, p.upMs);
          }, p.downMs);
        };
        flap();
        break;
      }

      case 'interface_down': {
        const iface = this.device.interfaceByIndex(p.interface);
        if (!iface) throw new Error(`No interface with index ${p.interface}`);
        handle.restore = () => { iface.operUp = true; };
        iface.operUp = false;
        this.emitSyslog(`%LINK-3-UPDOWN: Interface ${iface.name}, changed state to down`, 3);
        later(() => this.clear(name), p.durationMs);
        break;
      }

      case 'cpu_spike': {
        this.device.cpu = p.target;
        this.emitSyslog(`%SYS-4-CPUHOG: Task is running for a long time, CPU at ${p.target}%`, 4);
        later(() => this.clear(name), p.durationMs);
        break;
      }

      case 'memory_leak':
        later(() => this.clear(name), p.durationMs);
        break;

      case 'interface_errors': {
        const iface = this.device.interfaceByIndex(p.interface);
        if (!iface) throw new Error(`No interface with index ${p.interface}`);
        handle.restore = () => { iface.errorRate = 0; };
        iface.errorRate = p.errorsPerSec;
        later(() => this.clear(name), p.durationMs);
        break;
      }

      case 'traffic_surge': {
        const iface = this.device.interfaceByIndex(p.interface);
        if (!iface) throw new Error(`No interface with index ${p.interface}`);
        handle.restore = () => { iface.loadFactor = 1; };
        iface.loadFactor = p.factor;
        later(() => this.clear(name), p.durationMs);
        break;
      }

      case 'auth_failure_burst': {
        const sources = Array.from({ length: p.sourceCount }, (_, i) => `10.0.0.${20 + i}`);
        let sent = 0;
        every(() => {
          if (sent >= p.count) { this.clear(name); return; }
          const src = sources[sent % sources.length];
          this.emitSyslog(
            `%SEC_LOGIN-4-LOGIN_FAILED: Login failed [user: admin] [Source: ${src}] ` +
            `[localport: 22] [Reason: Login Authentication Failed]`, 4,
          );
          sent += 1;
        }, p.intervalMs);
        break;
      }

      case 'total_loss': {
        handle.restore = () => { this.device.unreachable = false; };
        this.device.unreachable = true;
        later(() => this.clear(name), p.durationMs);
        break;
      }

      default:
        throw new Error(`Fault "${name}" has no implementation`);
    }

    return { fault: name, params: p, active: true };
  }

  clear(name) {
    const handle = this.running.get(name);
    if (!handle) return { fault: name, active: false, cleared: false };
    for (const t of handle.timers) { clearTimeout(t); clearInterval(t); }
    handle.restore();
    this.running.delete(name);
    this.device.activeFaults.delete(name);
    this.logger.info(`Cleared fault: ${name}`);
    return { fault: name, active: false, cleared: true };
  }

  clearAll() {
    const names = Array.from(this.running.keys());
    for (const n of names) this.clear(n);
    return { cleared: names };
  }

  emitSyslog(message, severity) {
    this.syslog?.send(message, severity);
  }
}

/**
 * Emits syslog to the agents that listen for it.
 *
 * Sends the same message to several ports because agents 1, 3, 4 and 5 each
 * bind their own listener rather than sharing one - a real deployment would
 * put a relay in front, but for a test fixture fanning out is simpler and
 * exercises every parser.
 */
class SyslogEmitter {
  constructor({ host = '127.0.0.1', ports = [5140, 5142, 5143, 5144], hostname = 'sim-router-1', logger = console } = {}) {
    this.host = host;
    this.ports = ports;
    this.hostname = hostname;
    this.logger = logger;
    this.socket = dgram.createSocket('udp4');
    this.socket.unref();
    this.sent = 0;
  }

  /** RFC 3164 style, which is what the agents' parsers expect. */
  send(message, severity = 6, facility = 23) {
    const pri = facility * 8 + severity;
    const ts = new Date().toISOString();
    const line = `<${pri}>${ts} ${this.hostname} ${message}`;
    const buf = Buffer.from(line, 'utf8');
    for (const port of this.ports) {
      this.socket.send(buf, port, this.host, (err) => {
        if (err) this.logger.debug?.(`syslog send to ${port} failed: ${err.message}`);
      });
    }
    this.sent += 1;
  }

  /** Background chatter, so the listeners are not silent between faults. */
  startHeartbeat(intervalMs = 30000) {
    this.heartbeat = setInterval(() => {
      this.send('%SYS-6-LOGGINGHOST_STARTSTOP: Logging to host started - CLI initiated', 6);
    }, intervalMs);
    this.heartbeat.unref?.();
  }

  stop() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    try { this.socket.close(); } catch { /* already closed */ }
  }
}

module.exports = { FaultEngine, SyslogEmitter, FAULTS };
