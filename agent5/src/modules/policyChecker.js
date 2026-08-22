const fs = require('fs').promises;
const path = require('path');
const logger = require('../utils/logger');
const snmpClient = require('../utils/snmpClient');

class PolicyChecker {
  constructor(config) {
    this.config = config;
    this.policies = [];
    this.violations = [];
    this.metrics = {
      policiesChecked: 0,
      violationsFound: 0,
      violationsFixed: 0,
      lastCheckTime: null
    };
  }

  async loadPolicies() {
    try {
      const policiesDir = path.join(__dirname, '../../policies');
      const files = await fs.readdir(policiesDir);
      
      for (const file of files) {
        if (file.endsWith('.json')) {
          const filePath = path.join(policiesDir, file);
          const content = await fs.readFile(filePath, 'utf8');
          const policy = JSON.parse(content);
          this.policies.push(policy);
          logger.info(`Loaded policy: ${policy.name} from ${file}`);
        }
      }
      
      logger.info(`Loaded ${this.policies.length} policies`);
      return this.policies;
    } catch (error) {
      logger.error(`Error loading policies: ${error.message}`);
      throw error;
    }
  }

  async checkAllRouters(routers) {
    this.violations = [];
    const results = [];

    for (const router of routers) {
      logger.info(`Checking policies for router: ${router.name}`);
      const routerResults = await this.checkRouter(router);
      results.push({
        router: router.name,
        host: router.host,
        compliance: routerResults.compliance,
        violations: routerResults.violations
      });
      this.violations.push(...routerResults.violations);
    }

    this.metrics.policiesChecked = routers.length * this.policies.length;
    this.metrics.violationsFound = this.violations.length;
    this.metrics.lastCheckTime = new Date().toISOString();

    return results;
  }

  async checkRouter(router) {
    const violations = [];
    let compliant = true;

    for (const policy of this.policies) {
      try {
        const result = await this.checkPolicy(router, policy);
        if (!result.compliant) {
          compliant = false;
          violations.push({
            policy: policy.name,
            severity: policy.severity,
            description: result.violation,
            currentValue: result.currentValue,
            expectedValue: policy.expectedValue,
            timestamp: new Date().toISOString()
          });
          logger.warn(`Policy violation on ${router.name}: ${policy.name}`);
        }
      } catch (error) {
        logger.error(`Error checking policy ${policy.name} on ${router.name}: ${error.message}`);
      }
    }

    return {
      compliant,
      violations,
      totalPolicies: this.policies.length,
      passedPolicies: this.policies.length - violations.length
    };
  }

  async checkPolicy(router, policy) {
    const snmp = new snmpClient(router);
    
    switch (policy.type) {
      case 'snmp_oid':
        return await this.checkSnmpOid(snmp, policy);
      
      case 'syslog_pattern':
        return await this.checkSyslogPattern(router, policy);
      
      case 'configuration':
        return await this.checkConfiguration(router, policy);
      
      default:
        throw new Error(`Unknown policy type: ${policy.type}`);
    }
  }

  async checkSnmpOid(snmp, policy) {
    try {
      const value = await snmp.get(policy.oid);
      const result = this.compareValues(value, policy.operator, policy.expectedValue);
      
      return {
        compliant: result,
        currentValue: value,
        violation: result ? null : `${policy.description}: Current value ${value} does not match expected ${policy.expectedValue}`
      };
    } catch (error) {
      logger.error(`SNMP check failed for OID ${policy.oid}: ${error.message}`);
      return {
        compliant: false,
        currentValue: 'N/A',
        violation: `Failed to retrieve SNMP data: ${error.message}`
      };
    }
  }

  async checkSyslogPattern(router, policy) {
    // This would check syslog messages for patterns
    // For now, return compliant as placeholder
    return {
      compliant: true,
      currentValue: 'N/A',
      violation: null
    };
  }

  async checkConfiguration(router, policy) {
    // This would check configuration via NETCONF/RESTCONF
    // For now, return compliant as placeholder
    return {
      compliant: true,
      currentValue: 'N/A',
      violation: null
    };
  }

  compareValues(actual, operator, expected) {
    const numActual = parseFloat(actual);
    const numExpected = parseFloat(expected);

    switch (operator) {
      case 'eq': return actual === expected;
      case 'ne': return actual !== expected;
      case 'gt': return numActual > numExpected;
      case 'lt': return numActual < numExpected;
      case 'gte': return numActual >= numExpected;
      case 'lte': return numActual <= numExpected;
      case 'contains': return actual.includes(expected);
      case 'not_contains': return !actual.includes(expected);
      default: return actual === expected;
    }
  }

  getMetrics() {
    return this.metrics;
  }

  getViolations() {
    return this.violations;
  }

  resetViolations() {
    this.violations = [];
  }
}

module.exports = PolicyChecker;