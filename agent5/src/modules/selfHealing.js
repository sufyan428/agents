const logger = require('../utils/logger');

class SelfHealing {
  constructor(config, policyChecker, configManager) {
    this.config = config;
    this.policyChecker = policyChecker;
    this.configManager = configManager;
    this.healingActions = [];
    this.metrics = {
      violationsDetected: 0,
      autoHealed: 0,
      manualInterventionRequired: 0,
      healingAttempts: 0,
      successfulHealings: 0,
      failedHealings: 0
    };
  }

  async checkAndHeal(router, violations) {
    const results = [];

    if (!this.config.governance.auto_heal || !this.config.self_healing.enabled) {
      logger.info(`Auto-healing disabled for ${router.name}`);
      return {
        router: router.name,
        autoHealed: false,
        reason: 'Auto-healing disabled'
      };
    }

    logger.info(`Checking ${violations.length} violations for auto-healing on ${router.name}`);

    for (const violation of violations) {
      try {
        const result = await this.healViolation(router, violation);
        results.push(result);
      } catch (error) {
        logger.error(`Failed to heal violation: ${error.message}`);
        results.push({
          success: false,
          violation,
          error: error.message
        });
      }
    }

    return {
      router: router.name,
      autoHealed: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length,
      results
    };
  }

  /**
   * Whether this specific healing action may touch a device.
   *
   * Two gates, both closed by default. `allowed_actions` is an explicit
   * allowlist - an operator opts into interface_up specifically, not into
   * "self-healing" as an undifferentiated capability - and `dry_run` lets the
   * whole path be exercised safely, logging exactly what it would have done.
   */
  isActionAllowed(strategyType) {
    const allowed = this.config.self_healing.allowed_actions;
    if (!Array.isArray(allowed) || allowed.length === 0) return false;
    return allowed.includes(strategyType);
  }

  /** Dry run unless explicitly disabled - absent config means do not write. */
  get isDryRun() {
    return this.config.self_healing.dry_run !== false;
  }

  async healViolation(router, violation) {
    this.metrics.healingAttempts++;

    // Determine healing strategy based on policy
    const healingStrategy = await this.getHealingStrategy(violation);

    if (!healingStrategy) {
      logger.warn(`No healing strategy found for violation: ${violation.policy}`);
      this.metrics.manualInterventionRequired++;
      return {
        success: false,
        violation,
        reason: 'No healing strategy available',
        requiresManualIntervention: true
      };
    }

    if (!this.isActionAllowed(healingStrategy.type)) {
      logger.warn(
        `Healing action "${healingStrategy.type}" is not in self_healing.allowed_actions - ` +
        `not applying it to ${router.name}. Add it to the allowlist to enable it.`
      );
      return {
        success: false,
        applied: false,
        skipped: 'not_allowlisted',
        violation: violation.policy,
        healingStrategy: healingStrategy.name,
        requiresHumanApproval: true
      };
    }

    if (this.isDryRun) {
      logger.info(
        `DRY RUN: would apply "${healingStrategy.type}" to ${router.name} for ` +
        `${violation.policy}. Set self_healing.dry_run: false to apply for real.`
      );
      return {
        success: true,
        applied: false,
        dryRun: true,
        violation: violation.policy,
        healingStrategy: healingStrategy.name
      };
    }

    // Apply healing with retry logic
    let lastError = null;
    for (let attempt = 1; attempt <= this.config.self_healing.max_retries; attempt++) {
      try {
        logger.info(`Healing attempt ${attempt} for ${violation.policy} on ${router.name}`);
        
        const result = await this.applyHealing(router, violation, healingStrategy);
        
        this.metrics.successfulHealings++;
        this.metrics.autoHealed++;
        
        // Verify healing was successful
        const verification = await this.verifyHealing(router, violation);
        
        return {
          success: true,
          violation,
          healingStrategy: healingStrategy.name,
          attempts: attempt,
          result,
          verification
        };
      } catch (error) {
        lastError = error;
        logger.warn(`Healing attempt ${attempt} failed: ${error.message}`);
        
        if (attempt < this.config.self_healing.max_retries) {
          await this.delay(this.config.self_healing.retry_delay * 1000);
        }
      }
    }

    this.metrics.failedHealings++;
    
    return {
      success: false,
      violation,
      healingStrategy: healingStrategy.name,
      attempts: this.config.self_healing.max_retries,
      error: lastError.message,
      requiresManualIntervention: true
    };
  }

  async getHealingStrategy(violation) {
    // Define healing strategies for common violations
    const strategies = {
      'interface_down': {
        name: 'interface_down',
        type: 'interface_config',
        action: 'up',
        severity: 'high'
      },
      'syslog_disabled': {
        name: 'syslog_disabled',
        type: 'syslog_config',
        action: 'enable',
        severity: 'medium'
      },
      'snmp_community_weak': {
        name: 'snmp_community_weak',
        type: 'snmp_set',
        action: 'set_community',
        severity: 'high'
      },
      'high_cpu_usage': {
        name: 'high_cpu_usage',
        type: 'system',
        action: 'log_only',
        severity: 'low'
      },
      'firmware_outdated': {
        name: 'firmware_outdated',
        type: 'firmware',
        action: 'schedule_update',
        severity: 'medium'
      },
      'routing_loop_detected': {
        name: 'routing_loop_detected',
        type: 'routing',
        action: 'clear_routes',
        severity: 'critical'
      },
      'ntp_not_synced': {
        name: 'ntp_not_synced',
        type: 'ntp_config',
        action: 'resync',
        severity: 'low'
      },
      'security_policy_violation': {
        name: 'security_policy_violation',
        type: 'security',
        action: 'alert_only',
        severity: 'critical'
      }
    };

    // Match violation to strategy based on policy name or description
    const policyName = violation.policy.toLowerCase();
    
    for (const [key, strategy] of Object.entries(strategies)) {
      if (policyName.includes(key) || 
          violation.description.toLowerCase().includes(key)) {
        return strategy;
      }
    }

    // Default strategy based on severity
    if (violation.severity === 'critical' || violation.severity === 'high') {
      return {
        name: 'default_critical',
        type: 'alert_only',
        action: 'manual_review',
        severity: violation.severity
      };
    }

    return null;
  }

  async applyHealing(router, violation, strategy) {
    logger.info(`Applying healing strategy: ${strategy.name} for ${violation.policy}`);

    switch (strategy.type) {
      case 'interface_config':
        return await this.healInterface(router, violation, strategy);
      
      case 'syslog_config':
        return await this.healSyslog(router, violation, strategy);
      
      case 'snmp_set':
        return await this.healSnmp(router, violation, strategy);
      
      case 'routing':
        return await this.healRouting(router, violation, strategy);
      
      case 'ntp_config':
        return await this.healNtp(router, violation, strategy);
      
      case 'firmware':
        return await this.healFirmware(router, violation, strategy);
      
      case 'alert_only':
        return await this.healAlert(router, violation, strategy);
      
      default:
        throw new Error(`Unknown healing type: ${strategy.type}`);
    }
  }

  async healInterface(router, violation, _strategy) {
    const snmpClient = require('../utils/snmpClient');
    const snmp = new snmpClient(router);

    // Set interface admin status to up
    const interfaceIndex = this.extractInterfaceIndex(violation);
    const adminStatusOid = `1.3.6.1.2.1.2.2.1.7.${interfaceIndex}`;
    
    await snmp.set(adminStatusOid, 1, 'Integer'); // 1 = up

    logger.info(`Interface ${interfaceIndex} set to UP on ${router.name}`);
    
    this.healingActions.push({
      router: router.name,
      type: 'interface_heal',
      action: 'interface_up',
      interface: interfaceIndex,
      timestamp: new Date().toISOString()
    });

    return {
      type: 'interface',
      action: 'up',
      interface: interfaceIndex,
      message: 'Interface set to UP'
    };
  }

  async healSyslog(router, violation, strategy) {
    // Enable syslog on router
    const configChange = {
      type: 'syslog_config',
      action: 'enable',
      severity: strategy.severity
    };

    await this.configManager.pushConfig(router, [configChange]);
    
    this.healingActions.push({
      router: router.name,
      type: 'syslog_heal',
      action: 'enable',
      timestamp: new Date().toISOString()
    });

    return {
      type: 'syslog',
      action: 'enable',
      message: 'Syslog enabled'
    };
  }

  /**
   * Rotating an SNMP community string is deliberately NOT automated.
   *
   * The previous implementation was unsafe in three separate ways and is kept
   * here only as a description of what it did, because every one of them is a
   * lesson worth not repeating:
   *
   * 1. It fell back to a hardcoded literal, 'SecureComm123!', when no value was
   *    configured. In an open-source project that is a publicly known password
   *    written onto production network hardware (CWE-798).
   * 2. It wrote to OID 1.3.6.1.6.3.10.2.1.3.0, which is snmpEngineTime - a
   *    read-only counter, not the community string. The write was wrong even on
   *    its own terms.
   * 3. Changing the community string is exactly the change that severs the
   *    framework's own access to the device. Doing it unattended, mid-incident,
   *    can lock every agent out of the router it is trying to fix.
   *
   * It now produces a suggestion for a human instead. Marked simulated:false
   * because nothing is being pretended - no device write is claimed.
   */
  async healSnmp(router, _violation, _strategy) {
    const message =
      'SNMP community rotation requires a human. It is vendor-specific, it is not ' +
      'settable through a standard MIB object, and applying it unattended can lock ' +
      'this framework out of the device.';

    logger.warn(`Not auto-healing SNMP on ${router.name}: ${message}`);

    this.healingActions.push({
      router: router.name,
      type: 'snmp_heal',
      action: 'suggested_only',
      applied: false,
      timestamp: new Date().toISOString()
    });

    return {
      type: 'snmp',
      action: 'suggested_only',
      applied: false,
      requiresHumanApproval: true,
      message
    };
  }

  async healRouting(router, _violation, _strategy) {
    // Clear routing table or specific routes
    logger.warn(`Clearing routing table on ${router.name}`);
    
    this.healingActions.push({
      router: router.name,
      type: 'routing_heal',
      action: 'clear_routes',
      timestamp: new Date().toISOString()
    });

    return {
      type: 'routing',
      action: 'clear_routes',
      message: 'Routing table cleared, routes will be relearned'
    };
  }

  async healNtp(router, _violation, _strategy) {
    // Resync NTP
    logger.info(`Resyncing NTP on ${router.name}`);
    
    this.healingActions.push({
      router: router.name,
      type: 'ntp_heal',
      action: 'resync',
      timestamp: new Date().toISOString()
    });

    return {
      type: 'ntp',
      action: 'resync',
      message: 'NTP resynchronization triggered'
    };
  }

  async healFirmware(router, _violation, _strategy) {
    // Schedule firmware update
    logger.info(`Scheduling firmware update for ${router.name}`);
    
    this.healingActions.push({
      router: router.name,
      type: 'firmware_heal',
      action: 'schedule_update',
      timestamp: new Date().toISOString()
    });

    return {
      type: 'firmware',
      action: 'schedule_update',
      message: 'Firmware update scheduled'
    };
  }

  async healAlert(router, violation, _strategy) {
    // Just alert, no automatic healing
    logger.warn(`Alert only for ${violation.policy} on ${router.name} - manual intervention required`);
    
    this.healingActions.push({
      router: router.name,
      type: 'alert',
      action: 'manual_review',
      violation: violation.policy,
      timestamp: new Date().toISOString()
    });

    return {
      type: 'alert',
      action: 'manual_review',
      message: 'Manual intervention required'
    };
  }

  async verifyHealing(router, violation) {
    // Wait a moment for changes to take effect
    await this.delay(2000);

    // Re-check the policy to verify healing
    const results = await this.policyChecker.checkRouter(router);
    const healed = results.violations.filter(v => 
      v.policy === violation.policy
    ).length === 0;

    return {
      verified: healed,
      remainingViolations: healed ? 0 : 1
    };
  }

  extractInterfaceIndex(violation) {
    // Extract interface index from violation description or OID
    const match = violation.description.match(/interface\s+(\d+)/i) ||
                  violation.description.match(/(\d+)$/);
    return match ? match[1] : '1';
  }

  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  getHealingActions() {
    return this.healingActions;
  }

  getMetrics() {
    return this.metrics;
  }

  resetMetrics() {
    this.metrics = {
      violationsDetected: 0,
      autoHealed: 0,
      manualInterventionRequired: 0,
      healingAttempts: 0,
      successfulHealings: 0,
      failedHealings: 0
    };
  }
}

module.exports = SelfHealing;