const { declareSimulated, markSimulated } = require('@ragent/agent-common');

declareSimulated(
  'agent5.checkConfiguration',
  'Returns compliant without reading the device configuration.',
  'a NETCONF or RESTCONF read of the running config'
);

const fs = require('fs').promises;
const path = require('path');
const logger = require('../utils/logger');
const snmpClient = require('../utils/snmpClient');

class PolicyChecker {
  constructor(config, syslogListener = null) {
    // Supplied by the agent so policy checks can query real received syslog.
    // Without it the syslog policy type reports that it could not be evaluated,
    // rather than quietly passing.
    this.syslogListener = syslogListener;
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

  /**
   * Evaluates a syslog policy against messages actually received.
   *
   * This used to return `compliant: true` unconditionally - the most dangerous
   * shape of fake data in the framework, because a clean compliance result is
   * exactly what a report narrates to an operator as fact. The listener was
   * already retaining messages; nothing was ever asking it.
   *
   * A policy declares a `pattern` and an `expectation`:
   *   absent  (default) - compliant when the pattern does NOT appear
   *   present           - compliant when it does
   *
   * `withinMinutes` bounds the window; `maxOccurrences` allows a threshold
   * rather than a binary.
   */
  async checkSyslogPattern(router, policy) {
    if (!this.syslogListener) {
      // Not compliant and not a violation - simply not evaluated. Saying so is
      // the honest answer; claiming a pass is not.
      return {
        compliant: null,
        verified: false,
        currentValue: 'no syslog listener available',
        violation: null,
        notEvaluated: 'this check needs a syslog listener; none was provided'
      };
    }

    const pattern = policy.pattern || policy.expectedValue;
    if (!pattern) {
      return {
        compliant: null,
        verified: false,
        currentValue: 'policy has no pattern',
        violation: null,
        notEvaluated: 'syslog policies require a "pattern"'
      };
    }

    const windowMinutes = policy.withinMinutes ?? 60;
    const cutoff = Date.now() - windowMinutes * 60 * 1000;
    const expectation = policy.expectation || 'absent';
    const maxOccurrences = policy.maxOccurrences ?? 0;

    let regex;
    try {
      regex = new RegExp(pattern, 'i');
    } catch (error) {
      return {
        compliant: null,
        verified: false,
        currentValue: `invalid pattern: ${error.message}`,
        violation: null,
        notEvaluated: 'the policy pattern is not a valid regular expression'
      };
    }

    const host = router.host || router.name;
    const candidates = this.syslogListener
      .getMessages(null, 1000)
      .filter((m) => {
        const ts = new Date(m.timestamp || m.receivedAt || 0).getTime();
        if (Number.isFinite(ts) && ts < cutoff) return false;
        if (host && m.hostname && m.hostname !== host && m.source !== host) return false;
        return regex.test(m.message || '');
      });

    const count = candidates.length;
    const compliant = expectation === 'present'
      ? count > 0
      : count <= maxOccurrences;

    return {
      compliant,
      verified: true,
      currentValue: `${count} match(es) in the last ${windowMinutes}m`,
      matchCount: count,
      sampleMatch: candidates.length ? String(candidates[candidates.length - 1].message).slice(0, 200) : null,
      violation: compliant
        ? null
        : expectation === 'present'
          ? `${policy.description || pattern}: expected at least one match in the last ${windowMinutes}m, found none`
          : `${policy.description || pattern}: found ${count} match(es) in the last ${windowMinutes}m (limit ${maxOccurrences})`
    };
  }

  /** SIMULATED. See checkSyslogPattern - returns compliant without reading the device. */
  async checkConfiguration(router, policy) {
    return {
      ...markSimulated('agent5.checkConfiguration', logger),
      compliant: true,
      verified: false,
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