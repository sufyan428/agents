const snmp = require('snmp-native');
const Logger = require('../utils/logger');

class SNMPMonitor {
  constructor(config, logger, metrics) {
    this.config = config;
    this.logger = logger;
    this.metrics = metrics;
  }

  async query(routerConfig, oid) {
    const startTime = Date.now();
    try {
      const versionStr = String(routerConfig.version || '2c').toLowerCase();
      const snmpVersion = versionStr === '1' || versionStr === 'v1'
        ? snmp.Versions.SNMPv1
        : snmp.Versions.SNMPv2c;

      const session = new snmp.Session({
        host: routerConfig.host,
        port: routerConfig.port || 161,
        community: routerConfig.community || 'public',
        version: snmpVersion,
        timeout: routerConfig.timeout || 5000,
        retries: routerConfig.retries || 3
      });

      const normalizedOid = oid.startsWith('.') ? oid : `.${oid}`;

      const result = await new Promise((resolve, reject) => {
        session.get({ oid: normalizedOid }, (error, varbinds) => {
          session.close();
          if (error) {
            reject(error);
          } else {
            resolve(varbinds);
          }
        });
      });

      const duration = (Date.now() - startTime) / 1000;
      this.metrics.recordSnmpQueryDuration(routerConfig.host, oid, duration);

      return result;
    } catch (error) {
      const duration = (Date.now() - startTime) / 1000;
      this.metrics.recordSnmpQueryDuration(routerConfig.host, oid, duration);
      this.metrics.recordSnmpQueryError(routerConfig.host, error.code || 'unknown');
      
      this.logger.error(`SNMP query failed for ${routerConfig.host}`, {
        oid: oid,
        error: error.message
      });
      
      throw error;
    }
  }

  async getRouterInfo(routerConfig) {
    try {
      const systemUptime = await this.query(routerConfig, '1.3.6.1.2.1.1.3.0');
      const systemName = await this.query(routerConfig, '1.3.6.1.2.1.1.5.0');
      const systemDescription = await this.query(routerConfig, '1.3.6.1.2.1.1.1.0');

      return {
        host: routerConfig.host,
        uptime: systemUptime[0]?.value || 0,
        name: systemName[0]?.value?.toString() || 'Unknown',
        description: systemDescription[0]?.value?.toString() || 'Unknown',
        timestamp: new Date().toISOString(),
        status: 'up'
      };
    } catch (error) {
      return {
        host: routerConfig.host,
        status: 'down',
        error: error.message,
        timestamp: new Date().toISOString()
      };
    }
  }

  async checkHealth(routerConfig) {
    const startTime = Date.now();
    const routerType = routerConfig === this.config.primary ? 'primary' : 'backup';
    
    try {
      const info = await this.getRouterInfo(routerConfig);
      const responseTime = (Date.now() - startTime) / 1000;

      this.metrics.updateResponseTime(routerType, 'snmp', responseTime);
      this.metrics.recordHeartbeatSuccess(routerType, 'snmp');

      if (info.status === 'up') {
        this.metrics.updateUptime(routerType, info.uptime / 100); // Convert to seconds
      }

      this.logger.logHealthCheck({
        router: routerConfig.host,
        status: info.status,
        response_time: responseTime,
        method: 'snmp',
        uptime: info.uptime
      });

      return {
        success: info.status === 'up',
        responseTime,
        data: info
      };
    } catch (error) {
      const responseTime = (Date.now() - startTime) / 1000;
      this.metrics.updateResponseTime(routerType, 'snmp', responseTime);
      
      this.logger.error(`SNMP health check failed for ${routerConfig.host}`, {
        error: error.message,
        responseTime
      });

      return {
        success: false,
        responseTime,
        error: error.message
      };
    }
  }

  async monitorMultipleOIDs(routerConfig, oids) {
    const results = {};
    for (const oid of oids) {
      try {
        const result = await this.query(routerConfig, oid);
        results[oid] = result[0]?.value || null;
      } catch (error) {
        results[oid] = null;
        this.logger.warn(`Failed to query OID ${oid} on ${routerConfig.host}`, {
          error: error.message
        });
      }
    }
    return results;
  }

  async getInterfaceStats(routerConfig) {
    const interfaceOids = [
      '1.3.6.1.2.1.2.2.1.10',  // Interface bytes in
      '1.3.6.1.2.1.2.2.1.16'   // Interface bytes out
    ];
    
    return await this.monitorMultipleOIDs(routerConfig, interfaceOids);
  }

  close() {
    // Cleanup if needed
  }
}

module.exports = SNMPMonitor;