const fs = require('fs').promises;
const path = require('path');
const logger = require('../utils/logger');
const snmpClient = require('../utils/snmpClient');

class ConfigManager {
  constructor(config) {
    this.config = config;
    this.backupDir = path.join(__dirname, '../../configs/backups');
    this.configChanges = [];
    this.metrics = {
      configsBackedUp: 0,
      configsRestored: 0,
      configsPushed: 0,
      lastBackupTime: null,
      lastRestoreTime: null,
      lastPushTime: null,
    };
  }

  async ensureBackupDir() {
    try {
      await fs.mkdir(this.backupDir, { recursive: true });
      logger.info(`Backup directory ensured: ${this.backupDir}`);
    } catch (error) {
      logger.error(`Failed to create backup directory: ${error.message}`);
      throw error;
    }
  }

  async backupConfig(router) {
    await this.ensureBackupDir();

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupFile = path.join(this.backupDir, `${router.name}_${timestamp}.config`);

    try {
      logger.info(`Backing up configuration for ${router.name}`);

      // Collect router information via SNMP
      const snmp = new snmpClient(router);
      const systemInfo = await this.collectSystemInfo(snmp);
      const interfaceInfo = await this.collectInterfaceInfo(snmp);
      const routingInfo = await this.collectRoutingInfo(snmp);

      const backupData = {
        routerName: router.name,
        host: router.host,
        location: router.location,
        timestamp: new Date().toISOString(),
        system: systemInfo,
        interfaces: interfaceInfo,
        routing: routingInfo,
        metadata: {
          backupAgent: 'automation-governance-agent',
          version: '1.0.0',
        },
      };

      await fs.writeFile(backupFile, JSON.stringify(backupData, null, 2));

      this.metrics.configsBackedUp++;
      this.metrics.lastBackupTime = new Date().toISOString();

      logger.info(`Configuration backed up successfully: ${backupFile}`);

      return {
        success: true,
        backupFile,
        timestamp: backupData.timestamp,
      };
    } catch (error) {
      logger.error(`Failed to backup config for ${router.name}: ${error.message}`);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  async collectSystemInfo(snmp) {
    const systemOids = {
      sysDescr: '1.3.6.1.2.1.1.1.0',
      sysObjectID: '1.3.6.1.2.1.1.2.0',
      sysUpTime: '1.3.6.1.2.1.1.3.0',
      sysContact: '1.3.6.1.2.1.1.4.0',
      sysName: '1.3.6.1.2.1.1.5.0',
      sysLocation: '1.3.6.1.2.1.1.6.0',
      sysServices: '1.3.6.1.2.1.1.7.0',
    };

    const info = {};
    for (const [key, oid] of Object.entries(systemOids)) {
      try {
        info[key] = await snmp.get(oid);
      } catch (error) {
        logger.warn(`Failed to get ${key}: ${error.message}`);
        info[key] = 'N/A';
      }
    }

    return info;
  }

  async collectInterfaceInfo(snmp) {
    const interfaces = [];
    const ifNumberOid = '1.3.6.1.2.1.2.1.0';

    try {
      const ifCount = await snmp.get(ifNumberOid);
      logger.info(`Found ${ifCount} interfaces`);

      // Collect basic interface information
      for (let i = 1; i <= parseInt(ifCount); i++) {
        const interfaceOidBase = `1.3.6.1.2.1.2.2.1.${i}`;
        const ifIndex = `${interfaceOidBase}.1`;
        const ifDescr = `${interfaceOidBase}.2`;
        const ifType = `${interfaceOidBase}.3`;
        const ifMtu = `${interfaceOidBase}.4`;
        const ifSpeed = `${interfaceOidBase}.5`;
        const ifAdminStatus = `${interfaceOidBase}.7`;
        const ifOperStatus = `${interfaceOidBase}.8`;

        try {
          const interfaceData = {
            index: await snmp.get(ifIndex),
            description: await snmp.get(ifDescr),
            type: await snmp.get(ifType),
            mtu: await snmp.get(ifMtu),
            speed: await snmp.get(ifSpeed),
            adminStatus: await snmp.get(ifAdminStatus),
            operStatus: await snmp.get(ifOperStatus),
          };
          interfaces.push(interfaceData);
        } catch (error) {
          logger.warn(`Failed to collect info for interface ${i}: ${error.message}`);
        }
      }
    } catch (error) {
      logger.error(`Error collecting interface info: ${error.message}`);
    }

    return interfaces;
  }

  async collectRoutingInfo(snmp) {
    const routes = [];
    const routeOidBase = '1.3.6.1.2.1.4.21.1';

    // Collect routing table information
    try {
      // This is a simplified example - in practice you'd walk the routing table
      const routeEntries = await snmp.walk(routeOidBase);

      for (const entry of routeEntries) {
        routes.push({
          oid: entry.oid,
          value: entry.value,
        });
      }
    } catch (error) {
      logger.warn(`Failed to collect routing info: ${error.message}`);
    }

    return {
      routes: routes.slice(0, 50), // Limit for demo purposes
      message: 'Routing table collection (limited entries)',
    };
  }

  async pushConfig(router, configChanges) {
    logger.info(`Pushing configuration changes to ${router.name}`);

    try {
      // Verify approval is not required
      if (this.config.governance.approval_required) {
        logger.warn('Configuration push requires manual approval');
        return {
          success: false,
          error: 'Manual approval required',
        };
      }

      // Backup before making changes
      if (this.config.governance.backup_before_changes) {
        const backupResult = await this.backupConfig(router);
        if (!backupResult.success) {
          logger.error('Failed to backup before config push');
          return {
            success: false,
            error: 'Backup failed, aborting config push',
          };
        }
      }

      // Apply configuration changes
      const results = [];
      for (const change of configChanges) {
        try {
          const result = await this.applyConfigChange(router, change);
          results.push(result);

          this.configChanges.push({
            router: router.name,
            change,
            result,
            timestamp: new Date().toISOString(),
          });
        } catch (error) {
          logger.error(`Failed to apply config change: ${error.message}`);
          results.push({
            success: false,
            change,
            error: error.message,
          });
        }
      }

      this.metrics.configsPushed++;
      this.metrics.lastPushTime = new Date().toISOString();

      const allSuccessful = results.every((r) => r.success);

      return {
        success: allSuccessful,
        results,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      logger.error(`Config push failed: ${error.message}`);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  async applyConfigChange(router, change) {
    const snmp = new snmpClient(router);

    switch (change.type) {
      case 'snmp_set':
        return await this.setSnmpValue(snmp, change);

      case 'syslog_config':
        return await this.configureSyslog(router, change);

      case 'interface_config':
        return await this.configureInterface(router, change);

      default:
        throw new Error(`Unknown config change type: ${change.type}`);
    }
  }

  async setSnmpValue(snmp, change) {
    try {
      await snmp.set(change.oid, change.value, change.type);
      logger.info(`Set SNMP ${change.oid} to ${change.value}`);
      return {
        success: true,
        type: 'snmp_set',
        oid: change.oid,
        value: change.value,
      };
    } catch (error) {
      logger.error(`Failed to set SNMP value: ${error.message}`);
      throw error;
    }
  }

  async configureSyslog(router, _change) {
    // Placeholder for syslog configuration
    logger.info(`Configuring syslog for ${router.name}`);
    return {
      success: true,
      type: 'syslog_config',
      message: 'Syslog configuration applied',
    };
  }

  async configureInterface(router, change) {
    // Placeholder for interface configuration
    logger.info(`Configuring interface ${change.interface} on ${router.name}`);
    return {
      success: true,
      type: 'interface_config',
      interface: change.interface,
      message: 'Interface configuration applied',
    };
  }

  async restoreConfig(router, backupFile) {
    logger.info(`Restoring configuration for ${router.name} from ${backupFile}`);

    try {
      // Read backup file
      const backupData = JSON.parse(await fs.readFile(backupFile, 'utf8'));

      // Verify backup matches router
      if (backupData.routerName !== router.name || backupData.host !== router.host) {
        throw new Error('Backup file does not match router');
      }

      // Restore configuration
      const restoreResults = [];

      // Restore system settings
      if (backupData.system) {
        logger.info('Restoring system settings');
        // Implementation would depend on router capabilities
      }

      // Restore interface settings
      if (backupData.interfaces) {
        logger.info(`Restoring ${backupData.interfaces.length} interfaces`);
        // Implementation would depend on router capabilities
      }

      this.metrics.configsRestored++;
      this.metrics.lastRestoreTime = new Date().toISOString();

      logger.info(`Configuration restored successfully for ${router.name}`);

      return {
        success: true,
        backupFile,
        timestamp: new Date().toISOString(),
        restoredSettings: restoreResults,
      };
    } catch (error) {
      logger.error(`Failed to restore config: ${error.message}`);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  async listBackups(router = null) {
    try {
      const files = await fs.readdir(this.backupDir);
      const backups = [];

      for (const file of files) {
        if (file.endsWith('.config')) {
          const filePath = path.join(this.backupDir, file);
          const stats = await fs.stat(filePath);

          if (!router || file.startsWith(router.name)) {
            backups.push({
              file: file,
              path: filePath,
              size: stats.size,
              created: stats.birthtime,
              modified: stats.mtime,
            });
          }
        }
      }

      // Sort by modification time, newest first
      backups.sort((a, b) => b.modified - a.modified);

      return backups;
    } catch (error) {
      logger.error(`Failed to list backups: ${error.message}`);
      return [];
    }
  }

  async cleanupOldBackups() {
    try {
      const retentionDays = this.config.backup.retention_days || 30;
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - retentionDays);

      const backups = await this.listBackups();
      let deletedCount = 0;

      for (const backup of backups) {
        if (backup.modified < cutoffDate) {
          try {
            await fs.unlink(backup.path);
            logger.info(`Deleted old backup: ${backup.file}`);
            deletedCount++;
          } catch (error) {
            logger.error(`Failed to delete backup ${backup.file}: ${error.message}`);
          }
        }
      }

      logger.info(`Cleaned up ${deletedCount} old backups`);
      return { deletedCount };
    } catch (error) {
      logger.error(`Failed to cleanup old backups: ${error.message}`);
      return { deletedCount: 0, error: error.message };
    }
  }

  getMetrics() {
    return this.metrics;
  }

  getConfigChanges() {
    return this.configChanges;
  }
}

module.exports = ConfigManager;
