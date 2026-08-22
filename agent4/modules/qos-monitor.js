const { declareSimulated, markSimulated } = require('@ragent/agent-common');

declareSimulated(
  'agent4.qosMetrics',
  'ALL QoS class metrics are generated. There is no real collection path.',
  'per-class counters via CISCO-CLASS-BASED-QOS-MIB, or the vendor equivalent'
);

const winston = require('winston');

class QosMonitor {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.qosMetrics = {};
    this.violations = {};
  }

  async collectMetrics() {
    const metrics = {
      classes: [],
      violations: {},
      timestamp: new Date().toISOString()
    };

    try {
      // Initialize QoS classes from config
      const priorityClasses = this.config.qos.priority_classes || [];

      for (const cls of priorityClasses) {
        const classMetrics = await this.collectClassMetrics(cls);
        metrics.classes.push(classMetrics);

        // Track violations
        const violations = this.detectViolations(classMetrics);
        if (violations.length > 0) {
          metrics.violations[cls.name] = violations.length;
          this.violations[cls.name] = violations;
        }
      }

      this.logger.info(`QoS metrics collected: ${metrics.classes.length} classes, ` +
                      `${Object.keys(metrics.violations).length} violations`);

    } catch (error) {
      this.logger.error(`Error collecting QoS metrics: ${error.message}`);
      // Return simulated data for testing
      return this.getSimulatedMetrics(metrics);
    }

    return metrics;
  }

  /**
   * SIMULATED - entirely. Unlike the SNMP and ICMP fallbacks elsewhere in this
   * agent, there is no real collection path here at all: every QoS number this
   * framework reports is generated, on every run, whether or not a device is
   * reachable. Real per-class statistics need CISCO-CLASS-BASED-QOS-MIB or the
   * vendor equivalent.
   */
  async collectClassMetrics(cls) {
    markSimulated('agent4.qosMetrics', this.logger);

    const bandwidthUtilization = Math.random() * 100;
    const packetCount = Math.floor(Math.random() * 10000) + 1000;
    const byteCount = Math.floor(Math.random() * 10000000) + 1000000;
    const droppedPackets = Math.floor(Math.random() * 100);

    // Check if bandwidth exceeds allocated percentage
    const allocatedBandwidth = cls.bandwidth_percent;
    const isOverLimit = bandwidthUtilization > allocatedBandwidth;

    return {
      name: cls.name,
      priority: cls.priority,
      bandwidthUtilization: parseFloat(bandwidthUtilization.toFixed(2)),
      allocatedBandwidth: allocatedBandwidth,
      packetCount: packetCount,
      byteCount: byteCount,
      droppedPackets: droppedPackets,
      isOverLimit: isOverLimit,
      timestamp: new Date().toISOString()
    };
  }

  detectViolations(classMetrics) {
    const violations = [];

    // Check bandwidth violation
    if (classMetrics.isOverLimit) {
      violations.push({
        type: 'bandwidth_exceeded',
        description: `${classMetrics.name} class exceeded bandwidth allocation: ` +
                   `${classMetrics.bandwidthUtilization}% > ${classMetrics.allocatedBandwidth}%`,
        severity: 'high',
        timestamp: new Date().toISOString()
      });
    }

    // Check packet drop threshold
    const dropThreshold = 50;
    if (classMetrics.droppedPackets > dropThreshold) {
      violations.push({
        type: 'excessive_drops',
        description: `${classMetrics.name} class has excessive packet drops: ` +
                   `${classMetrics.droppedPackets} packets`,
        severity: 'medium',
        timestamp: new Date().toISOString()
      });
    }

    return violations;
  }

  getSimulatedMetrics(baseMetrics) {
    this.logger.info('Using simulated QoS metrics');

    const priorityClasses = this.config.qos.priority_classes || [];

    for (const cls of priorityClasses) {
      const classMetrics = {
        name: cls.name,
        priority: cls.priority,
        bandwidthUtilization: parseFloat((Math.random() * 100).toFixed(2)),
        allocatedBandwidth: cls.bandwidth_percent,
        packetCount: Math.floor(Math.random() * 10000) + 1000,
        byteCount: Math.floor(Math.random() * 10000000) + 1000000,
        droppedPackets: Math.floor(Math.random() * 100),
        isOverLimit: false,
        timestamp: new Date().toISOString()
      };

      // Simulate violations occasionally
      if (Math.random() > 0.8) {
        classMetrics.bandwidthUtilization = cls.bandwidth_percent + Math.random() * 20;
        classMetrics.isOverLimit = true;
        baseMetrics.violations[cls.name] = 1;
      }

      baseMetrics.classes.push(classMetrics);
    }

    return baseMetrics;
  }

  getViolationSummary() {
    return this.violations;
  }

  clearViolations() {
    this.violations = {};
  }
}

module.exports = QosMonitor;