const { declareSimulated, markSimulated } = require('@ragent/agent-common');

declareSimulated('agent2.netconfFetch', 'Returns a placeholder string instead of the device config.', 'a NETCONF client session');
declareSimulated('agent2.snmpConfigFetch', 'Returns a placeholder string instead of the device config.', 'an SNMP config-transfer MIB walk');
declareSimulated('agent2.applyNetconf', 'Reports a config as applied without sending it.', 'a NETCONF edit-config transaction');
declareSimulated('agent2.applyRestconf', 'Reports a config as applied without sending it.', 'a RESTCONF PATCH against the device');

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const Logger = require('../utils/logger');

class ConfigSync {
  constructor(config, logger, metrics) {
    this.config = config;
    this.logger = logger;
    this.metrics = metrics;
    
    this.syncStatus = 'unknown';
    this.lastSyncTime = null;
    this.syncErrors = 0;
    this.syncTimer = null;
  }

  start() {
    if (!this.config.sync?.enabled) {
      this.logger.info('Configuration sync is disabled');
      return;
    }

    const interval = this.config.sync?.sync_interval || 60000;
    
    this.syncTimer = setInterval(() => {
      this.performSync();
    }, interval);

    this.logger.info('Configuration sync started', {
      interval: `${interval}ms`
    });

    // Initial sync
    this.performSync();
  }

  stop() {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
      this.logger.info('Configuration sync stopped');
    }
  }

  async performSync() {
    if (!this.config.sync?.enabled) {
      return;
    }

    this.logger.info('Starting configuration synchronization');

    try {
      const startTime = Date.now();
      
      // Determine source and destination
      const source = this.currentActiveRouter === 'primary' 
        ? this.config.primary 
        : this.config.backup;
      const destination = this.currentActiveRouter === 'primary' 
        ? this.config.backup 
        : this.config.primary;

      // Fetch configuration from source
      const configData = await this.fetchConfiguration(source);
      
      // Backup the configuration
      await this.backupConfiguration(source, configData);
      
      // Apply configuration to destination
      const syncResult = await this.applyConfiguration(destination, configData);
      
      const duration = Date.now() - startTime;
      
      if (syncResult.success) {
        this.syncStatus = 'synced';
        this.lastSyncTime = new Date().toISOString();
        this.syncErrors = 0;
        
        this.metrics.updateConfigSyncStatus(true);
        this.metrics.updateConfigSyncLastSuccess(Date.now() / 1000);
        
        this.logger.logConfigSync({
          type: 'periodic',
          status: 'success',
          source: source.host,
          destination: destination.host,
          duration
        });
      } else {
        throw new Error(syncResult.message);
      }

    } catch (error) {
      this.syncStatus = 'out-of-sync';
      this.syncErrors++;
      
      this.metrics.updateConfigSyncStatus(false);
      this.metrics.recordConfigSyncError('sync_failure');
      
      this.logger.error('Configuration sync failed', {
        error: error.message,
        sync_errors: this.syncErrors
      });

      this.logger.logConfigSync({
        type: 'periodic',
        status: 'failed',
        error: error.message
      });
    }
  }

  async fetchConfiguration(routerConfig) {
    const config = {};
    const commands = this.config.sync?.sync_commands || [];

    this.logger.info(`Fetching configuration from ${routerConfig.host}`);

    for (const command of commands) {
      try {
        const result = await this.executeCommand(routerConfig, command);
        config[command] = result;
      } catch (error) {
        this.logger.warn(`Failed to execute command "${command}" on ${routerConfig.host}`, {
          error: error.message
        });
        config[command] = null;
      }
    }

    return config;
  }

  async executeCommand(routerConfig, command) {
    // Try NETCONF if enabled
    if (routerConfig.netconf?.enabled) {
      return await this.executeNetconfCommand(routerConfig, command);
    }
    
    // Try RESTCONF if enabled
    if (routerConfig.restconf?.enabled) {
      return await this.executeRestconfCommand(routerConfig, command);
    }
    
    // Fallback to SNMP or simulation
    return await this.executeSnmpCommand(routerConfig, command);
  }

  async executeNetconfCommand(routerConfig, command) {
    this.logger.info(`Executing NETCONF command on ${routerConfig.host}`, {
      command
    });

    // This is a placeholder for actual NETCONF implementation
    // You would use a NETCONF library here
    
    return {
      method: 'netconf',
      ...markSimulated('agent2.netconfFetch', this.logger),
      command,
      result: null,
      timestamp: new Date().toISOString()
    };
  }

  async executeRestconfCommand(routerConfig, command) {
    this.logger.info(`Executing RESTCONF command on ${routerConfig.host}`, {
      command
    });

    if (process.env.ROUTER_TLS_INSECURE === 'true' && !ConfigSync.warnedInsecureTls) {
      ConfigSync.warnedInsecureTls = true;
      this.logger.warn(
        'ROUTER_TLS_INSECURE=true - router certificates are NOT being verified. ' +
        'RESTCONF credentials can be intercepted. Do not use this outside a lab.'
      );
    }

    const protocol = routerConfig.restconf?.protocol || 'https';
    const port = routerConfig.restconf?.port || 443;
    const username = routerConfig.restconf?.username;
    const password = routerConfig.restconf?.password;

    try {
      const url = `${protocol}://${routerConfig.host}:${port}/restconf/data`;
      
      const response = await axios.get(url, {
        auth: {
          username,
          password
        },
        timeout: 5000,
        httpsAgent: new https.Agent({
          // Verifying the router's certificate is the default. This request
          // carries RESTCONF admin credentials, so disabling verification
          // hands them to anyone who can intercept the connection.
          // Opt out only for a lab device with a self-signed cert, and only
          // by setting ROUTER_TLS_INSECURE=true deliberately.
          rejectUnauthorized: process.env.ROUTER_TLS_INSECURE !== 'true'
        })
      });

      return {
        method: 'restconf',
        command,
        result: response.data,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      throw new Error(`RESTCONF execution failed: ${error.message}`);
    }
  }

  async executeSnmpCommand(routerConfig, command) {
    this.logger.info(`Executing SNMP-based config fetch on ${routerConfig.host}`, {
      command
    });

    // This would use the SNMPMonitor to get configuration
    // For now, return a placeholder
    
    return {
      ...markSimulated('agent2.snmpConfigFetch', this.logger),
      method: 'snmp',
      command,
      result: null,
      timestamp: new Date().toISOString()
    };
  }

  async backupConfiguration(routerConfig, configData) {
    const backupPath = this.config.sync?.backup_path || '/app/data/config-backups';
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `config-${routerConfig.host}-${timestamp}.json`;
    const filepath = path.join(backupPath, filename);

    try {
      // Ensure backup directory exists
      if (!fs.existsSync(backupPath)) {
        fs.mkdirSync(backupPath, { recursive: true });
      }

      const backupData = {
        router: routerConfig.host,
        timestamp: new Date().toISOString(),
        configuration: configData
      };

      fs.writeFileSync(filepath, JSON.stringify(backupData, null, 2));
      
      this.logger.info(`Configuration backed up to ${filepath}`);
      
      return {
        success: true,
        path: filepath
      };
    } catch (error) {
      this.logger.error('Failed to backup configuration', {
        error: error.message,
        path: filepath
      });
      throw error;
    }
  }

  async applyConfiguration(routerConfig, configData) {
    this.logger.info(`Applying configuration to ${routerConfig.host}`);

    try {
      // Try NETCONF if enabled
      if (routerConfig.netconf?.enabled) {
        return await this.applyViaNetconf(routerConfig, configData);
      }
      
      // Try RESTCONF if enabled
      if (routerConfig.restconf?.enabled) {
        return await this.applyViaRestconf(routerConfig, configData);
      }
      
      // For simulation purposes
      this.logger.info('Configuration sync completed (simulation mode)');
      
      return {
        success: true,
        message: 'Configuration applied successfully'
      };
    } catch (error) {
      this.logger.error('Failed to apply configuration', {
        error: error.message,
        router: routerConfig.host
      });
      throw error;
    }
  }

  async applyViaNetconf(routerConfig, configData) {
    // Placeholder for NETCONF config application
    return {
      success: true,
      method: 'netconf',
      message: 'Configuration applied via NETCONF'
    };
  }

  async applyViaRestconf(routerConfig, configData) {
    // Placeholder for RESTCONF config application
    return {
      success: true,
      method: 'restconf',
      message: 'Configuration applied via RESTCONF'
    };
  }

  async triggerManualSync(triggerType) {
    this.logger.info(`Manual sync triggered: ${triggerType}`);
    
    try {
      await this.performSync();
      
      return {
        success: true,
        message: `Manual sync (${triggerType}) completed successfully`
      };
    } catch (error) {
      return {
        success: false,
        message: `Manual sync failed: ${error.message}`
      };
    }
  }

  getSyncStatus() {
    return {
      status: this.syncStatus,
      lastSyncTime: this.lastSyncTime,
      syncErrors: this.syncErrors,
      isActive: this.syncTimer !== null
    };
  }

  getCurrentActiveRouter() {
    return this.currentActiveRouter;
  }

  setCurrentActiveRouter(router) {
    this.currentActiveRouter = router;
  }
}

module.exports = ConfigSync;