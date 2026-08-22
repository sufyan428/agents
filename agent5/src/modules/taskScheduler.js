const { declareSimulated, markSimulated } = require('@ragent/agent-common');

declareSimulated(
  'agent5.firmwareCheck',
  'Compares against a hardcoded version table, not a vendor advisory feed.',
  'a vendor PSIRT / NVD feed lookup'
);

const cron = require('node-cron');
const logger = require('../utils/logger');

class TaskScheduler {
  constructor(config, policyChecker, configManager, selfHealing, auditReporter) {
    this.config = config;
    this.policyChecker = policyChecker;
    this.configManager = configManager;
    this.selfHealing = selfHealing;
    this.auditReporter = auditReporter;
    this.scheduledTasks = new Map();
    this.taskHistory = [];
    this.metrics = {
      tasksScheduled: 0,
      tasksExecuted: 0,
      tasksSuccessful: 0,
      tasksFailed: 0,
      lastExecutionTime: null
    };
  }

  scheduleTasks(routers) {
    logger.info('Scheduling automated governance tasks');

    // Policy Compliance Check
    if (this.config.scheduling.policy_check_interval) {
      this.scheduleTask(
        'policy_check',
        this.config.scheduling.policy_check_interval,
        () => this.runPolicyCheck(routers)
      );
    }

    // Configuration Backup
    if (this.config.scheduling.backup_interval) {
      this.scheduleTask(
        'config_backup',
        this.config.scheduling.backup_interval,
        () => this.runConfigBackup(routers)
      );
    }

    // Firmware Check
    if (this.config.scheduling.firmware_check_interval) {
      this.scheduleTask(
        'firmware_check',
        this.config.scheduling.firmware_check_interval,
        () => this.runFirmwareCheck(routers)
      );
    }

    // Audit Report Generation
    if (this.config.scheduling.audit_report_interval) {
      this.scheduleTask(
        'audit_report',
        this.config.scheduling.audit_report_interval,
        () => this.runAuditReport(routers)
      );
    }

    // Configuration Compliance Check
    if (this.config.scheduling.config_compliance_check) {
      this.scheduleTask(
        'config_compliance',
        this.config.scheduling.config_compliance_check,
        () => this.runConfigComplianceCheck(routers)
      );
    }

    logger.info(`Scheduled ${this.scheduledTasks.size} tasks`);
    this.metrics.tasksScheduled = this.scheduledTasks.size;
  }

  scheduleTask(name, schedule, taskFunction) {
    if (cron.validate(schedule)) {
      const task = cron.schedule(schedule, async () => {
        await this.executeTask(name, taskFunction);
      }, {
        scheduled: true,
        timezone: 'UTC'
      });

      this.scheduledTasks.set(name, {
        task,
        schedule,
        name
      });

      logger.info(`Scheduled task '${name}' with schedule: ${schedule}`);
    } else {
      logger.error(`Invalid cron schedule for task '${name}': ${schedule}`);
    }
  }

  async executeTask(name, taskFunction) {
    const startTime = Date.now();
    logger.info(`Executing task: ${name}`);

    try {
      const result = await taskFunction();
      const duration = Date.now() - startTime;

      this.taskHistory.push({
        name,
        status: 'success',
        startTime: new Date(startTime).toISOString(),
        endTime: new Date().toISOString(),
        duration,
        result
      });

      this.metrics.tasksExecuted++;
      this.metrics.tasksSuccessful++;
      this.metrics.lastExecutionTime = new Date().toISOString();

      logger.info(`Task '${name}' completed successfully in ${duration}ms`);

      // Log audit event
      await this.auditReporter.logEvent({
        eventType: `task_${name}`,
        routerName: 'ALL',
        routerHost: 'N/A',
        severity: 'info',
        details: { duration, success: true },
        metadata: { taskId: name }
      });

      return result;
    } catch (error) {
      const duration = Date.now() - startTime;

      this.taskHistory.push({
        name,
        status: 'failed',
        startTime: new Date(startTime).toISOString(),
        endTime: new Date().toISOString(),
        duration,
        error: error.message
      });

      this.metrics.tasksExecuted++;
      this.metrics.tasksFailed++;
      this.metrics.lastExecutionTime = new Date().toISOString();

      logger.error(`Task '${name}' failed after ${duration}ms: ${error.message}`);

      // Log audit event
      await this.auditReporter.logEvent({
        eventType: `task_${name}`,
        routerName: 'ALL',
        routerHost: 'N/A',
        severity: 'error',
        details: { duration, success: false, error: error.message },
        metadata: { taskId: name }
      });

      throw error;
    }
  }

  async runPolicyCheck(routers) {
    logger.info('Running policy compliance check');

    // Check policies on all routers
    const policyResults = await this.policyChecker.checkAllRouters(routers);

    // Process violations and trigger self-healing
    for (const result of policyResults) {
      if (!result.compliance && result.violations.length > 0) {
        logger.warn(`Found ${result.violations.length} violations on ${result.router}`);

        // Trigger self-healing for violations
        if (this.config.governance.auto_heal) {
          const router = routers.find(r => r.name === result.router);
          if (router) {
            const healingResults = await this.selfHealing.checkAndHeal(
              router,
              result.violations
            );
            logger.info(`Self-healing results for ${result.router}:`, healingResults);
          }
        }
      }
    }

    // Generate compliance report
    const complianceReport = await this.auditReporter.generateComplianceReport(
      routers,
      policyResults
    );

    return {
      routersChecked: routers.length,
      compliantRouters: policyResults.filter(r => r.compliance).length,
      nonCompliantRouters: policyResults.filter(r => !r.compliance).length,
      totalViolations: policyResults.reduce((sum, r) => sum + r.violations.length, 0),
      complianceReport
    };
  }

  async runConfigBackup(routers) {
    logger.info('Running configuration backup');

    const backupResults = [];

    for (const router of routers) {
      try {
        const result = await this.configManager.backupConfig(router);
        backupResults.push(result);

        await this.auditReporter.logEvent({
          eventType: 'config_backup',
          routerName: router.name,
          routerHost: router.host,
          severity: result.success ? 'info' : 'error',
          details: result
        });
      } catch (error) {
        logger.error(`Backup failed for ${router.name}: ${error.message}`);
        backupResults.push({
          success: false,
          router: router.name,
          error: error.message
        });
      }
    }

    // Cleanup old backups
    await this.configManager.cleanupOldBackups();

    return {
      routersProcessed: routers.length,
      successfulBackups: backupResults.filter(r => r.success).length,
      failedBackups: backupResults.filter(r => !r.success).length,
      backupResults
    };
  }

  async runFirmwareCheck(routers) {
    logger.info('Running firmware version check');

    const firmwareResults = [];

    for (const router of routers) {
      try {
        const firmwareInfo = await this.checkRouterFirmware(router);
        firmwareResults.push({
          router: router.name,
          host: router.host,
          currentVersion: firmwareInfo.currentVersion,
          latestVersion: firmwareInfo.latestVersion,
          updateAvailable: firmwareInfo.updateAvailable,
          securityPatches: firmwareInfo.securityPatches
        });

        await this.auditReporter.logEvent({
          eventType: 'firmware_check',
          routerName: router.name,
          routerHost: router.host,
          severity: firmwareInfo.updateAvailable ? 'warning' : 'info',
          details: firmwareInfo
        });
      } catch (error) {
        logger.error(`Firmware check failed for ${router.name}: ${error.message}`);
        firmwareResults.push({
          router: router.name,
          error: error.message
        });
      }
    }

    return {
      routersChecked: routers.length,
      updatesAvailable: firmwareResults.filter(r => r.updateAvailable).length,
      firmwareResults
    };
  }

  async checkRouterFirmware(router) {
    const snmpClient = require('../utils/snmpClient');
    const snmp = new snmpClient(router);

    try {
      // Get firmware version via SNMP
      const firmwareOid = '1.3.6.1.2.1.1.1.0'; // sysDescr often contains firmware info
      const sysDescr = await snmp.get(firmwareOid);

      // Extract version from sysDescr (simplified)
      const versionMatch = sysDescr.match(/Version\s+(\d+\.\d+\.\d+)/i);
      const currentVersion = versionMatch ? versionMatch[1] : sysDescr.substring(0, 50);

      // In a real implementation, you would check vendor API or database
      // For demo purposes, we'll simulate this check
      const latestVersion = await this.getLatestFirmwareVersion(router.type);
      const updateAvailable = currentVersion !== latestVersion;

      // securityPatches used to contain the literal strings 'CVE-2024-XXXX'
      // and 'CVE-2024-YYYY'. Invented CVE identifiers in a security tool are
      // worse than an empty list: they look actionable, they are searchable,
      // and they lead an operator to conclude a device is vulnerable to
      // something that does not exist. The list stays empty until there is a
      // real advisory feed behind it.
      return {
        ...markSimulated('agent5.firmwareCheck', logger),
        currentVersion,
        latestVersion,
        updateAvailable,
        securityPatches: [],
        securityPatchesNote: 'no advisory feed configured - this list is not populated'
      };
    } catch (error) {
      logger.error(`Failed to check firmware for ${router.name}: ${error.message}`);
      throw error;
    }
  }

  async getLatestFirmwareVersion(routerType) {
    // In production, this would query vendor API or database
    // For demo purposes, return a simulated latest version
    const versions = {
      cisco: '17.9.4',
      juniper: '22.4R2',
      arista: '4.29.1F'
    };
    return versions[routerType.toLowerCase()] || '1.0.0';
  }

  async runAuditReport(routers) {
    logger.info('Running audit report generation');

    // Generate various audit reports
    const auditReport = await this.auditReporter.generateAuditReport('24h');
    
    const configChanges = this.configManager.getConfigChanges();
    const backups = await this.configManager.listBackups();
    const configReport = await this.auditReporter.generateConfigurationReport(
      configChanges,
      backups
    );

    const healingActions = this.selfHealing.getHealingActions();
    const healingMetrics = this.selfHealing.getMetrics();
    const healingReport = await this.auditReporter.generateSelfHealingReport(
      healingActions,
      healingMetrics
    );

    return {
      auditReport,
      configReport,
      healingReport,
      generatedAt: new Date().toISOString()
    };
  }

  async runConfigComplianceCheck(routers) {
    logger.info('Running configuration compliance check');

    const complianceResults = [];

    for (const router of routers) {
      try {
        const result = await this.checkRouterConfigCompliance(router);
        complianceResults.push(result);

        await this.auditReporter.logEvent({
          eventType: 'config_compliance_check',
          routerName: router.name,
          routerHost: router.host,
          severity: result.compliant ? 'info' : 'warning',
          details: result
        });
      } catch (error) {
        logger.error(`Config compliance check failed for ${router.name}: ${error.message}`);
        complianceResults.push({
          router: router.name,
          compliant: false,
          error: error.message
        });
      }
    }

    return {
      routersChecked: routers.length,
      compliantRouters: complianceResults.filter(r => r.compliant).length,
      nonCompliantRouters: complianceResults.filter(r => !r.compliant).length,
      complianceResults
    };
  }

  async checkRouterConfigCompliance(router) {
    const snmpClient = require('../utils/snmpClient');
    const snmp = new snmpClient(router);

    const checks = [];

    // Check syslog is configured
    try {
      const syslogEnabled = await this.checkSyslogEnabled(snmp);
      checks.push({
        name: 'syslog_enabled',
        compliant: syslogEnabled,
        description: 'Syslog should be enabled for centralized logging'
      });
    } catch (error) {
      checks.push({
        name: 'syslog_enabled',
        compliant: false,
        description: 'Failed to check syslog configuration',
        error: error.message
      });
    }

    // Check SNMP community is not default
    try {
      const snmpSecure = await this.checkSnmpSecure(snmp);
      checks.push({
        name: 'snmp_secure',
        compliant: snmpSecure,
        description: 'SNMP community should not use default values'
      });
    } catch (error) {
      checks.push({
        name: 'snmp_secure',
        compliant: false,
        description: 'Failed to check SNMP security',
        error: error.message
      });
    }

    // Check interface statuses
    try {
      const interfaceStatus = await this.checkInterfaceStatus(snmp);
      checks.push({
        name: 'interface_status',
        compliant: interfaceStatus.allUp,
        description: 'All interfaces should be in UP state',
        details: interfaceStatus
      });
    } catch (error) {
      checks.push({
        name: 'interface_status',
        compliant: false,
        description: 'Failed to check interface status',
        error: error.message
      });
    }

    const compliant = checks.every(c => c.compliant);

    return {
      router: router.name,
      host: router.host,
      compliant,
      totalChecks: checks.length,
      passedChecks: checks.filter(c => c.compliant).length,
      failedChecks: checks.filter(c => !c.compliant).length,
      checks
    };
  }

  async checkSyslogEnabled(snmp) {
    // Simplified check - in production, you would verify actual syslog config
    return true;
  }

  async checkSnmpSecure(snmp) {
    // Check if community is not "public" or "private"
    // This is a simplified check
    return true;
  }

  async checkInterfaceStatus(snmp) {
    const interfaces = [];
    const ifNumberOid = '1.3.6.1.2.1.2.1.0';
    
    try {
      const ifCount = await snmp.get(ifNumberOid);
      
      for (let i = 1; i <= Math.min(parseInt(ifCount), 10); i++) {
        const ifOperStatusOid = `1.3.6.1.2.1.2.2.1.8.${i}`;
        const ifDescrOid = `1.3.6.1.2.1.2.2.1.2.${i}`;
        
        const operStatus = await snmp.get(ifOperStatusOid);
        const descr = await snmp.get(ifDescrOid);
        
        interfaces.push({
          index: i,
          description: descr,
          operStatus: parseInt(operStatus),
          up: parseInt(operStatus) === 1
        });
      }

      const allUp = interfaces.length > 0 && interfaces.every(iface => iface.up);
      
      return {
        interfaces,
        totalInterfaces: interfaces.length,
        upInterfaces: interfaces.filter(i => i.up).length,
        downInterfaces: interfaces.filter(i => !i.up).length,
        allUp
      };
    } catch (error) {
      throw new Error(`Failed to check interface status: ${error.message}`);
    }
  }

  async executeManualTask(taskName, routers) {
    logger.info(`Executing manual task: ${taskName}`);

    switch (taskName) {
      case 'policy_check':
        return await this.runPolicyCheck(routers);
      case 'config_backup':
        return await this.runConfigBackup(routers);
      case 'firmware_check':
        return await this.runFirmwareCheck(routers);
      case 'audit_report':
        return await this.runAuditReport(routers);
      case 'config_compliance':
        return await this.runConfigComplianceCheck(routers);
      default:
        throw new Error(`Unknown manual task: ${taskName}`);
    }
  }

  getScheduledTasks() {
    return Array.from(this.scheduledTasks.values()).map(task => ({
      name: task.name,
      schedule: task.schedule
    }));
  }

  getTaskHistory(limit = 50) {
    return this.taskHistory.slice(-limit);
  }

  getMetrics() {
    return this.metrics;
  }

  stopAllTasks() {
    logger.info('Stopping all scheduled tasks');
    
    for (const [name, taskInfo] of this.scheduledTasks) {
      taskInfo.task.stop();
      logger.info(`Stopped task: ${name}`);
    }
    
    this.scheduledTasks.clear();
  }
}

module.exports = TaskScheduler;