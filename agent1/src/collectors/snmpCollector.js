/**
 * SNMP Collector
 * Collects router metrics using SNMP protocol
 */

const snmp = require('snmp-native');
const logger = require('../utils/logger');
const config = require('../utils/config');
const prometheus = require('../utils/prometheus');

class SNMPCollector {
  constructor() {
    this.sessions = new Map();
    this.defaultOids = config.getDefaultOids();
  }

  /**
   * Convert OID string to integer array
   */
  oidStringToArray(oidString) {
    if (!oidString || typeof oidString !== 'string') return null;
    try {
      return oidString.split('.').map(part => parseInt(part, 10));
    } catch (error) {
      logger.error(`Failed to convert OID string: ${oidString}`);
      return null;
    }
  }

  getVersion(versionString) {
    if (!versionString) return 1;
    const v = versionString.toLowerCase().trim();
    if (v === '1' || v === 'v1') return 0;
    return 1; // Default v2c
  }

  initialize() {
    const routers = config.getEnabledRouters();
    routers.forEach(router => {
      try {
        const session = new snmp.Session({
          host: router.ip,
          community: router.community || 'public',
          port: router.port || 161,
          version: this.getVersion(router.version),
          timeout: 5000
        });
        this.sessions.set(router.name, { session, router });
        logger.info(`SNMP session created for ${router.name} (${router.ip}:${router.port})`);
      } catch (error) {
        logger.error(`Failed to create SNMP session for ${router.name}: ${error.message}`);
      }
    });
  }

  async getSingleValue(session, oidString, routerName) {
    return new Promise((resolve) => {
      const oidArray = this.oidStringToArray(oidString);
      if (!oidArray) return resolve(null);

      try {
        session.get({ oid: oidArray }, (error, varbinds) => {
          if (error || !varbinds || varbinds.length === 0) {
            resolve(null);
          } else {
            resolve(varbinds[0].value);
          }
        });
      } catch (error) {
        resolve(null);
      }
    });
  }

  async collect(routerName) {
    const sessionData = this.sessions.get(routerName);
    if (!sessionData) return null;

    const { session, router } = sessionData;
    const routerOids = { ...this.defaultOids, ...(router.metrics || {}) };
    
    const metrics = {
      router: router.name,
      ip: router.ip,
      timestamp: Date.now(),
      cpu: null,
      memory: null,
      uptime: null,
      interfaces: []
    };

    try {
      // Uptime
      metrics.uptime = await this.getSingleValue(session, routerOids.uptime, routerName);
      if (metrics.uptime) prometheus.setUptime(router.name, router.ip, metrics.uptime / 100);

      // CPU
      metrics.cpu = await this.getSingleValue(session, routerOids.cpu, routerName);
      if (metrics.cpu !== null) prometheus.setCPU(router.name, router.ip, metrics.cpu);

      // Memory
      const used = await this.getSingleValue(session, routerOids.memory_used, routerName);
      const total = await this.getSingleValue(session, routerOids.memory_total, routerName);
      if (used && total) {
        metrics.memory = ((used / total) * 100).toFixed(2);
        prometheus.setMemory(router.name, router.ip, parseFloat(metrics.memory));
      }

      // Interfaces
      const interfaceStats = await this.collectInterfaceStats(session, router, routerOids);
      metrics.interfaces = interfaceStats;
      
      interfaceStats.forEach(iface => {
        prometheus.setBandwidth(router.name, router.ip, iface.name, iface.inOctets, iface.outOctets);
      });

      logger.info(`SNMP metrics collected successfully from ${router.name}`);
      return metrics;
    } catch (error) {
      logger.error(`Collection error for ${router.name}: ${error.message}`);
      return null;
    }
  }

  async collectInterfaceStats(session, router, routerOids) {
    const interfaces = [];
    try {
      // Walk the Interface Description tree
      const ifDescOid = '1.3.6.1.2.1.2.2.1.2';
      const ifItems = await this.getSubtree(session, ifDescOid, router.name);
      
      for (const item of ifItems) {
        const index = item.index;
        const name = item.value;

        const inOctets = await this.getSingleValue(session, `${routerOids.interface_in}.${index}`, router.name);
        const outOctets = await this.getSingleValue(session, `${routerOids.interface_out}.${index}`, router.name);
        const errors = await this.getSingleValue(session, `${routerOids.interface_errors}.${index}`, router.name);

        interfaces.push({
          index: parseInt(index),
          name: name || `if${index}`,
          inOctets: inOctets || 0,
          outOctets: outOctets || 0,
          errors: errors || 0
        });
      }
    } catch (error) {
      logger.error(`Interface stats failed for ${router.name}: ${error.message}`);
    }
    return interfaces;
  }

  getSubtree(session, baseOidStr, routerName) {
    return new Promise((resolve) => {
      const oidArray = this.oidStringToArray(baseOidStr);
      session.getSubtree({ oid: oidArray }, (err, varbinds) => {
        if (err) {
          logger.error(`Subtree error for ${routerName}: ${err.message}`);
          return resolve([]);
        }

        const results = varbinds.map(vb => {
          const currentOidStr = Array.isArray(vb.oid) ? vb.oid.join('.') : vb.oid;
          const index = currentOidStr.split('.').pop(); // Get last digit as index
          return { index, value: vb.value };
        });

        logger.info(`Subtree completed for ${routerName}, found ${results.length} items`);
        resolve(results);
      });
    });
  }

  async collectAll() {
    for (const [name, data] of this.sessions) {
      await this.collect(name);
    }
  }

  close() {
    this.sessions.forEach(s => s.session.close());
    this.sessions.clear();
  }
}

module.exports = new SNMPCollector();
