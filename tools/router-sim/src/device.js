/**
 * The simulated device's state.
 *
 * A deliberately simple model of a router: CPU, memory, uptime, and a set of
 * interfaces with monotonically increasing counters. It exists so the framework
 * has something real to talk to - real SNMP over a real socket, real syslog
 * over real UDP - without needing hardware.
 *
 * Two properties matter for it to be useful as a test target:
 *
 *   Counters only ever increase, and wrap at 32 bits like a real device does.
 *   Code that computes deltas has to handle the wrap, and it will never see
 *   that bug against a device that has been up for five minutes.
 *
 *   Every value is a pure function of elapsed time plus injected faults, so a
 *   scenario replays identically. A test that depends on a random walk is a
 *   test that fails once a fortnight for no reason.
 */

const COUNTER32_MAX = 4294967296; // 2^32

class Interface {
  constructor({ index, name, speedBps, baseUtilisation }) {
    this.index = index;
    this.name = name;
    this.speedBps = speedBps;
    this.baseUtilisation = baseUtilisation; // 0..1
    this.adminUp = true;
    this.operUp = true;
    this.inOctets = 0;
    this.outOctets = 0;
    this.inErrors = 0;
    this.outErrors = 0;
    /** Multiplier applied by fault injection. */
    this.loadFactor = 1;
    /** Errors added per second while a fault is active. */
    this.errorRate = 0;
  }

  /** Advances counters by `seconds` of traffic at the current load. */
  advance(seconds) {
    if (!this.operUp) return;
    const utilisation = Math.min(this.baseUtilisation * this.loadFactor, 1);
    const bytesPerSecond = (this.speedBps * utilisation) / 8;
    // Slight asymmetry, because a real link is rarely balanced.
    this.inOctets = (this.inOctets + Math.round(bytesPerSecond * seconds)) % COUNTER32_MAX;
    this.outOctets = (this.outOctets + Math.round(bytesPerSecond * 0.7 * seconds)) % COUNTER32_MAX;
    if (this.errorRate > 0) {
      this.inErrors = (this.inErrors + Math.round(this.errorRate * seconds)) % COUNTER32_MAX;
    }
  }

  /** IF-MIB ifOperStatus: 1 up, 2 down. */
  get operStatus() { return this.operUp ? 1 : 2; }
  get adminStatus() { return this.adminUp ? 1 : 2; }
}

class Device {
  constructor(opts = {}) {
    this.name = opts.name || 'sim-router-1';
    this.description = opts.description
      || 'Simulated Router, Router Agent Framework test fixture, Version 1.0';
    this.location = opts.location || 'Simulation';
    this.contact = opts.contact || 'router-agent-framework';

    this.startedAt = Date.now();
    this.lastAdvance = Date.now();

    // Baselines. Faults move the current values away from these and they decay
    // back, so a spike looks like a spike rather than a step change.
    this.baseCpu = opts.baseCpu ?? 22;
    this.baseMemoryUsedPct = opts.baseMemory ?? 41;
    this.memoryTotalBytes = opts.memoryTotalBytes ?? 2 * 1024 * 1024 * 1024;

    this.cpu = this.baseCpu;
    this.memoryUsedPct = this.baseMemoryUsedPct;

    /** Set true by the total_loss fault: the device stops answering entirely. */
    this.unreachable = false;

    this.interfaces = [
      new Interface({ index: 1, name: 'GigabitEthernet0/0', speedBps: 1e9, baseUtilisation: 0.18 }),
      new Interface({ index: 2, name: 'GigabitEthernet0/1', speedBps: 1e9, baseUtilisation: 0.06 }),
      new Interface({ index: 3, name: 'Loopback0', speedBps: 8e9, baseUtilisation: 0.001 }),
    ];

    /** Faults currently active, by name. */
    this.activeFaults = new Map();
  }

  get uptimeTicks() {
    // sysUpTime is in hundredths of a second.
    return Math.floor((Date.now() - this.startedAt) / 10);
  }

  get memoryUsedBytes() {
    return Math.round(this.memoryTotalBytes * (this.memoryUsedPct / 100));
  }

  interfaceByIndex(index) {
    return this.interfaces.find((i) => i.index === Number(index));
  }

  /**
   * Advances the model. Called on a timer; also safe to call on demand.
   *
   * CPU and memory decay toward their baselines rather than snapping back, so
   * a spike produces a curve that threshold and baselining logic can actually
   * be tested against.
   */
  tick(now = Date.now()) {
    const seconds = Math.max((now - this.lastAdvance) / 1000, 0);
    this.lastAdvance = now;
    if (seconds === 0) return;

    for (const iface of this.interfaces) iface.advance(seconds);

    const decay = Math.min(seconds / 30, 1);
    this.cpu += (this.baseCpu - this.cpu) * decay;
    this.memoryUsedPct += (this.baseMemoryUsedPct - this.memoryUsedPct) * decay;

    // A memory leak fault overrides the decay and climbs instead.
    const leak = this.activeFaults.get('memory_leak');
    if (leak) {
      this.memoryUsedPct = Math.min(this.memoryUsedPct + (leak.ratePctPerSec ?? 0.5) * seconds, 99);
    }
    const spike = this.activeFaults.get('cpu_spike');
    if (spike) {
      this.cpu = spike.target ?? 95;
    }

    this.cpu = Math.max(0, Math.min(this.cpu, 100));
    this.memoryUsedPct = Math.max(0, Math.min(this.memoryUsedPct, 100));
  }

  snapshot() {
    this.tick();
    return {
      name: this.name,
      unreachable: this.unreachable,
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      cpuPercent: Math.round(this.cpu * 10) / 10,
      memoryUsedPercent: Math.round(this.memoryUsedPct * 10) / 10,
      memoryUsedBytes: this.memoryUsedBytes,
      memoryTotalBytes: this.memoryTotalBytes,
      interfaces: this.interfaces.map((i) => ({
        index: i.index,
        name: i.name,
        adminUp: i.adminUp,
        operUp: i.operUp,
        inOctets: i.inOctets,
        outOctets: i.outOctets,
        inErrors: i.inErrors,
        loadFactor: i.loadFactor,
      })),
      activeFaults: Array.from(this.activeFaults.entries()).map(([name, f]) => ({ name, ...f })),
    };
  }

  reset() {
    this.startedAt = Date.now();
    this.lastAdvance = Date.now();
    this.cpu = this.baseCpu;
    this.memoryUsedPct = this.baseMemoryUsedPct;
    this.unreachable = false;
    this.activeFaults.clear();
    for (const i of this.interfaces) {
      i.adminUp = true;
      i.operUp = true;
      i.loadFactor = 1;
      i.errorRate = 0;
      i.inOctets = 0;
      i.outOctets = 0;
      i.inErrors = 0;
    }
  }
}

module.exports = { Device, Interface, COUNTER32_MAX };
