const fs = require('fs').promises;
const path = require('path');
const logger = require('../utils/logger');

class AuditReporter {
  constructor(config) {
    this.config = config;
    this.auditDir = path.join(__dirname, '../../logs/audit');
    this.auditLogs = [];
    this.metrics = {
      reportsGenerated: 0,
      auditEntries: 0,
      lastReportTime: null,
    };
  }

  async ensureAuditDir() {
    try {
      await fs.mkdir(this.auditDir, { recursive: true });
      logger.info(`Audit directory ensured: ${this.auditDir}`);
    } catch (error) {
      logger.error(`Failed to create audit directory: ${error.message}`);
      throw error;
    }
  }

  async logEvent(event) {
    if (!this.config.audit.enabled) {
      return;
    }

    await this.ensureAuditDir();

    const auditEntry = {
      timestamp: new Date().toISOString(),
      eventType: event.eventType,
      routerName: event.routerName,
      routerHost: event.routerHost,
      severity: event.severity || 'info',
      details: event.details,
      user: event.user || 'automation-governance-agent',
      result: event.result || 'success',
      metadata: event.metadata || {},
    };

    this.auditLogs.push(auditEntry);
    this.metrics.auditEntries++;

    // Write to audit file
    const today = new Date().toISOString().split('T')[0];
    const auditFile = path.join(this.auditDir, `audit_${today}.log`);

    try {
      const entryText = this.formatAuditEntry(auditEntry);
      await fs.appendFile(auditFile, entryText + '\n');
      logger.debug(`Audit event logged: ${event.eventType}`);
    } catch (error) {
      logger.error(`Failed to write audit entry: ${error.message}`);
    }

    return auditEntry;
  }

  formatAuditEntry(entry) {
    if (this.config.audit.format === 'json') {
      return JSON.stringify(entry);
    } else {
      return `[${entry.timestamp}] [${entry.severity.toUpperCase()}] ${entry.eventType} - ${entry.routerName}: ${JSON.stringify(entry.details)}`;
    }
  }

  async generateComplianceReport(routers, policyResults) {
    logger.info('Generating compliance report');

    const report = {
      reportType: 'compliance',
      generatedAt: new Date().toISOString(),
      summary: {
        totalRouters: routers.length,
        compliantRouters: policyResults.filter((r) => r.compliance).length,
        nonCompliantRouters: policyResults.filter((r) => !r.compliance).length,
        totalViolations: policyResults.reduce((sum, r) => sum + r.violations.length, 0),
      },
      routers: policyResults.map((result) => ({
        name: result.router,
        host: result.host,
        compliant: result.compliance,
        totalPolicies: result.totalPolicies,
        passedPolicies: result.passedPolicies,
        failedPolicies: result.violations.length,
        violations: result.violations,
      })),
      recommendations: this.generateRecommendations(policyResults),
    };

    await this.saveReport('compliance_report', report);
    await this.logEvent({
      eventType: 'compliance_report',
      routerName: 'ALL',
      routerHost: 'N/A',
      severity: 'info',
      details: { summary: report.summary },
      metadata: { reportId: report.generatedAt },
    });

    this.metrics.reportsGenerated++;
    this.metrics.lastReportTime = new Date().toISOString();

    return report;
  }

  async generateAuditReport(timeRange = '24h') {
    logger.info(`Generating audit report for time range: ${timeRange}`);

    const report = {
      reportType: 'audit',
      generatedAt: new Date().toISOString(),
      timeRange,
      summary: {
        totalEvents: this.auditLogs.length,
        criticalEvents: this.auditLogs.filter((e) => e.severity === 'critical').length,
        highEvents: this.auditLogs.filter((e) => e.severity === 'high').length,
        mediumEvents: this.auditLogs.filter((e) => e.severity === 'medium').length,
        lowEvents: this.auditLogs.filter((e) => e.severity === 'low').length,
      },
      eventsByType: this.groupEventsByType(),
      eventsByRouter: this.groupEventsByRouter(),
      recentEvents: this.auditLogs.slice(-100), // Last 100 events
    };

    await this.saveReport('audit_report', report);

    this.metrics.reportsGenerated++;
    this.metrics.lastReportTime = new Date().toISOString();

    return report;
  }

  async generateConfigurationReport(configChanges, backups) {
    logger.info('Generating configuration report');

    const report = {
      reportType: 'configuration',
      generatedAt: new Date().toISOString(),
      summary: {
        totalChanges: configChanges.length,
        successfulChanges: configChanges.filter((c) => c.result?.success).length,
        failedChanges: configChanges.filter((c) => !c.result?.success).length,
        totalBackups: backups.length,
      },
      recentChanges: configChanges.slice(-50),
      recentBackups: backups.slice(0, 50),
      changesByRouter: this.groupChangesByRouter(configChanges),
    };

    await this.saveReport('configuration_report', report);
    await this.logEvent({
      eventType: 'configuration_report',
      routerName: 'ALL',
      routerHost: 'N/A',
      severity: 'info',
      details: { summary: report.summary },
    });

    this.metrics.reportsGenerated++;
    this.metrics.lastReportTime = new Date().toISOString();

    return report;
  }

  async generateSelfHealingReport(healingActions, metrics) {
    logger.info('Generating self-healing report');

    const report = {
      reportType: 'self_healing',
      generatedAt: new Date().toISOString(),
      summary: {
        totalActions: healingActions.length,
        successfulHealings: metrics.successfulHealings,
        failedHealings: metrics.failedHealings,
        autoHealed: metrics.autoHealed,
        manualInterventionRequired: metrics.manualInterventionRequired,
      },
      healingActions: healingActions.slice(-100),
      healingByType: this.groupHealingByType(healingActions),
      healingByRouter: this.groupHealingByRouter(healingActions),
    };

    await this.saveReport('self_healing_report', report);
    await this.logEvent({
      eventType: 'self_healing_report',
      routerName: 'ALL',
      routerHost: 'N/A',
      severity: 'info',
      details: { summary: report.summary },
    });

    this.metrics.reportsGenerated++;
    this.metrics.lastReportTime = new Date().toISOString();

    return report;
  }

  generateRecommendations(policyResults) {
    const recommendations = [];

    for (const result of policyResults) {
      for (const violation of result.violations) {
        recommendations.push({
          router: result.router,
          policy: violation.policy,
          severity: violation.severity,
          recommendation: this.getRecommendation(violation),
          priority: this.getPriority(violation.severity),
        });
      }
    }

    // Sort by priority
    recommendations.sort(
      (a, b) => this.getPriorityValue(a.priority) - this.getPriorityValue(b.priority),
    );

    return recommendations.slice(0, 20); // Top 20 recommendations
  }

  getRecommendation(violation) {
    const policy = violation.policy.toLowerCase();

    if (policy.includes('interface') && policy.includes('down')) {
      return 'Check interface connectivity and bring interface UP. Investigate physical layer issues.';
    } else if (policy.includes('syslog') && policy.includes('disabled')) {
      return 'Enable syslog for centralized logging and monitoring compliance.';
    } else if (policy.includes('snmp') && (policy.includes('weak') || policy.includes('public'))) {
      return 'Change SNMP community string to a secure value and restrict SNMP access.';
    } else if (policy.includes('cpu') && policy.includes('high')) {
      return 'Investigate high CPU usage. Check for loops, unnecessary routing protocols, or security threats.';
    } else if (policy.includes('firmware') && policy.includes('outdated')) {
      return 'Schedule firmware update during maintenance window. Review release notes for critical fixes.';
    } else if (policy.includes('ntp') && policy.includes('sync')) {
      return 'Configure NTP servers and ensure time synchronization for accurate logging.';
    } else if (policy.includes('routing') && policy.includes('loop')) {
      return 'Investigate routing loop. Review routing protocol configuration and static routes.';
    } else if (policy.includes('security')) {
      return 'Review security policies and implement recommended security measures immediately.';
    } else {
      return 'Review violation details and implement corrective actions according to organizational policies.';
    }
  }

  getPriority(severity) {
    switch (severity) {
      case 'critical':
        return 'P0';
      case 'high':
        return 'P1';
      case 'medium':
        return 'P2';
      case 'low':
        return 'P3';
      default:
        return 'P4';
    }
  }

  getPriorityValue(priority) {
    switch (priority) {
      case 'P0':
        return 0;
      case 'P1':
        return 1;
      case 'P2':
        return 2;
      case 'P3':
        return 3;
      case 'P4':
        return 4;
      default:
        return 5;
    }
  }

  groupEventsByType() {
    const grouped = {};
    for (const event of this.auditLogs) {
      if (!grouped[event.eventType]) {
        grouped[event.eventType] = 0;
      }
      grouped[event.eventType]++;
    }
    return grouped;
  }

  groupEventsByRouter() {
    const grouped = {};
    for (const event of this.auditLogs) {
      if (!grouped[event.routerName]) {
        grouped[event.routerName] = 0;
      }
      grouped[event.routerName]++;
    }
    return grouped;
  }

  groupChangesByRouter(changes) {
    const grouped = {};
    for (const change of changes) {
      if (!grouped[change.router]) {
        grouped[change.router] = 0;
      }
      grouped[change.router]++;
    }
    return grouped;
  }

  groupHealingByType(actions) {
    const grouped = {};
    for (const action of actions) {
      if (!grouped[action.type]) {
        grouped[action.type] = 0;
      }
      grouped[action.type]++;
    }
    return grouped;
  }

  groupHealingByRouter(actions) {
    const grouped = {};
    for (const action of actions) {
      if (!grouped[action.router]) {
        grouped[action.router] = 0;
      }
      grouped[action.router]++;
    }
    return grouped;
  }

  async saveReport(reportName, report) {
    await this.ensureAuditDir();

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const reportFile = path.join(this.auditDir, `${reportName}_${timestamp}.json`);

    try {
      await fs.writeFile(reportFile, JSON.stringify(report, null, 2));
      logger.info(`Report saved: ${reportFile}`);
      return reportFile;
    } catch (error) {
      logger.error(`Failed to save report: ${error.message}`);
      throw error;
    }
  }

  async getRecentAuditLogs(limit = 100) {
    return this.auditLogs.slice(-limit);
  }

  getMetrics() {
    return this.metrics;
  }

  clearOldLogs() {
    // Keep last 1000 logs in memory
    if (this.auditLogs.length > 1000) {
      this.auditLogs = this.auditLogs.slice(-1000);
    }
  }
}

module.exports = AuditReporter;
