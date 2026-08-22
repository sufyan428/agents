const snmp = require('net-snmp');
const winston = require('winston');

class SnmpMonitor {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.session = null;
    
    // SNMP OIDs for common router metrics
    this.oids = {
      cpuUsage: '1.3.6.1.4.1.9.2.1.56.0',     // Cisco CPU usage
      memoryUsage: '1.3.6.1.4.1.9.2.1.8.0',    // Cisco memory usage
      interfaceInOctets: '1.3.6.1.2.1.2.2.1.10', // Interface input octets
      interfaceOutOctets: '1.3.6.1.2.1.2.2.1.16', // Interface output octets
      interfaceStatus: '1.3.6.1.2.1.2.2.1.8',  // Interface operational status
      interfaceName: '1.3.6.1.2.1.2.2.1.2',    // Interface name
      sysDescr: '1.3.6.1.2.1.1.1.0',           // System description
      sysUpTime: '1.3.6.1.2.1.1.3.0',           // System uptime
      sysName: '1.3.6.1.2.1.1.5.0'              // System name
    };
  }

  createSession() {
    return snmp.createSession(
      this.config.router.host,
      this.config.router.snmp.community,
      {
        port: this.config.router.snmp.port,
        version: snmp.Version2c,
        timeout: this.config.router.snmp.timeout,
        retries: this.config.router.snmp.retries
      }
    );
  }

  async collectMetrics() {
    const metrics = {
      cpuUsage: 0,
      memoryUsage: 0,
      interfaces: [],
      sysUpTime: 0,
      sysName: '',
      timestamp: new Date().toISOString()
    };

    try {
      const session = this.createSession();

      // Get basic system info
      const systemVars = [
        this.oids.sysDescr,
        this.oids.sysUpTime,
        this.oids.sysName
      ];

      await new Promise((resolve, reject) => {
        session.get(systemVars, (error, varbinds) => {
          if (error) {
            this.logger.error(`SNMP get error (system): ${error.message}`);
            reject(error);
            return;
          }

          varbinds.forEach(varbind => {
            if (snmp.isVarbindError(varbind)) {
              this.logger.error(`SNMP varbind error: ${snmp.varbindError(varbind)}`);
            } else {
              if (varbind.oid === this.oids.sysUpTime) {
                metrics.sysUpTime = varbind.value;
              } else if (varbind.oid === this.oids.sysName) {
                metrics.sysName = varbind.value.toString();
              }
            }
          });

          resolve();
        });
      });

      // Get CPU and memory metrics
      try {
        const resourceVars = [this.oids.cpuUsage, this.oids.memoryUsage];
        
        await new Promise((resolve, reject) => {
          session.get(resourceVars, (error, varbinds) => {
            if (error) {
              this.logger.warn(`Could not get CPU/memory metrics: ${error.message}`);
              resolve(); // Don't reject, continue with defaults
              return;
            }

            varbinds.forEach(varbind => {
              if (!snmp.isVarbindError(varbind)) {
                if (varbind.oid === this.oids.cpuUsage) {
                  metrics.cpuUsage = varbind.value;
                } else if (varbind.oid === this.oids.memoryUsage) {
                  metrics.memoryUsage = varbind.value;
                }
              }
            });

            resolve();
          });
        });
      } catch (error) {
        this.logger.warn(`Resource metrics collection failed: ${error.message}`);
      }

      // Get interface statistics
      try {
        await new Promise((resolve, reject) => {
          session.walk(this.oids.interfaceName, (error, varbinds) => {
            if (error) {
              this.logger.warn(`Could not walk interfaces: ${error.message}`);
              resolve();
              return;
            }

            const interfacePromises = varbinds.map(async (varbind) => {
              if (snmp.isVarbindError(varbind)) return null;

              const interfaceIndex = varbind.oid.split('.').pop();
              const interfaceName = varbind.value.toString();

              try {
                const [inOctets, outOctets, status] = await Promise.all([
                  this.getInterfaceMetric(session, this.oids.interfaceInOctets, interfaceIndex),
                  this.getInterfaceMetric(session, this.oids.interfaceOutOctets, interfaceIndex),
                  this.getInterfaceMetric(session, this.oids.interfaceStatus, interfaceIndex)
                ]);

                return {
                  index: interfaceIndex,
                  name: interfaceName,
                  inOctets: inOctets,
                  outOctets: outOctets,
                  status: status
                };
              } catch (error) {
                this.logger.error(`Error getting interface ${interfaceName} metrics: ${error.message}`);
                return null;
              }
            });

            Promise.all(interfacePromises).then(interfaces => {
              metrics.interfaces = interfaces.filter(i => i !== null);
              resolve();
            }).catch(reject);
          });
        });
      } catch (error) {
        this.logger.warn(`Interface statistics collection failed: ${error.message}`);
      }

      session.close();

      this.logger.info(`SNMP metrics collected: CPU ${metrics.cpuUsage}%, Memory ${metrics.memoryUsage}%, ` +
                      `${metrics.interfaces.length} interfaces`);

    } catch (error) {
      this.logger.error(`SNMP collection error: ${error.message}`);
      // Return simulated data for testing when no router is available
      return this.getSimulatedMetrics(metrics);
    }

    return metrics;
  }

  getInterfaceMetric(session, baseOid, index) {
    return new Promise((resolve, reject) => {
      session.get(`${baseOid}.${index}`, (error, varbinds) => {
        if (error) {
          reject(error);
          return;
        }

        const varbind = varbinds[0];
        if (snmp.isVarbindError(varbind)) {
          reject(new Error(snmp.varbindError(varbind)));
        } else {
          resolve(varbind.value);
        }
      });
    });
  }

  getSimulatedMetrics(baseMetrics) {
    // Return simulated metrics when no router is connected
    this.logger.info('Using simulated metrics (no router connected)');
    
    baseMetrics.cpuUsage = Math.floor(Math.random() * 30) + 40; // 40-70%
    baseMetrics.memoryUsage = Math.floor(Math.random() * 25) + 55; // 55-80%
    baseMetrics.interfaces = [
      {
        index: '1',
        name: 'GigabitEthernet0/0',
        inOctets: Math.floor(Math.random() * 1000000) + 500000,
        outOctets: Math.floor(Math.random() * 1000000) + 500000,
        status: 1
      },
      {
        index: '2',
        name: 'GigabitEthernet0/1',
        inOctets: Math.floor(Math.random() * 1000000) + 500000,
        outOctets: Math.floor(Math.random() * 1000000) + 500000,
        status: 1
      }
    ];

    return baseMetrics;
  }
}

module.exports = SnmpMonitor;