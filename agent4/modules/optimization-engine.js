const { declareSimulated, markSimulated } = require('@ragent/agent-common');

declareSimulated(
  'agent4.applyOptimization',
  'Reports an optimisation as applied without configuring anything.',
  'a NETCONF/RESTCONF write, gated behind the same allowlist and dry-run as agent5 self-healing'
);

const winston = require('winston');

class OptimizationEngine {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.optimizationHistory = [];
    this.appliedOptimizations = [];
  }

  async analyze(metrics) {
    const optimizations = [];
    const thresholds = this.config.optimization;

    // Check CPU usage
    if (metrics.cpu > thresholds.threshold_cpu) {
      optimizations.push({
        type: 'reduce_cpu_load',
        priority: 'high',
        description: `CPU usage (${metrics.cpu}%) exceeds threshold (${thresholds.threshold_cpu}%). ` +
                    'Consider reducing routing table size, disabling unnecessary services, ' +
                    'or upgrading hardware.',
        impact: 'high',
        estimatedImprovement: Math.min(20, metrics.cpu - thresholds.threshold_cpu),
        actions: [
          'Disable unused routing protocols',
          'Reduce logging verbosity',
          'Implement route summarization',
          'Check for routing loops'
        ]
      });
    }

    // Check memory usage
    if (metrics.memory > thresholds.threshold_memory) {
      optimizations.push({
        type: 'reduce_memory_usage',
        priority: 'high',
        description: `Memory usage (${metrics.memory}%) exceeds threshold (${thresholds.threshold_memory}%). ` +
                    'Clear buffers, reduce BGP table size, or add more memory.',
        impact: 'high',
        estimatedImprovement: Math.min(15, metrics.memory - thresholds.threshold_memory),
        actions: [
          'Clear ARP cache',
          'Reduce BGP routes received',
          'Disable unused features',
          'Implement route filtering'
        ]
      });
    }

    // Check latency
    for (const [dest, latency] of Object.entries(metrics.latency)) {
      if (latency > thresholds.threshold_latency) {
        optimizations.push({
          type: 'reduce_latency',
          priority: 'medium',
          description: `High latency to ${dest} (${latency.toFixed(2)}ms > ${thresholds.threshold_latency}ms). ` +
                      'Check link utilization, routing path, or consider QoS prioritization.',
          impact: 'medium',
          estimatedImprovement: Math.min(30, latency - thresholds.threshold_latency),
          destination: dest,
          actions: [
            'Check link utilization',
            'Verify optimal routing path',
            'Apply QoS prioritization',
            'Consider link aggregation'
          ]
        });
      }
    }

    // Check jitter
    for (const [dest, jitter] of Object.entries(metrics.jitter)) {
      if (jitter > thresholds.threshold_jitter) {
        optimizations.push({
          type: 'reduce_jitter',
          priority: 'medium',
          description: `High jitter to ${dest} (${jitter.toFixed(2)}ms > ${thresholds.threshold_jitter}ms). ` +
                      'Implement traffic shaping, queuing mechanisms, or prioritize real-time traffic.',
          impact: 'medium',
          estimatedImprovement: Math.min(25, jitter - thresholds.threshold_jitter),
          destination: dest,
          actions: [
            'Implement traffic shaping',
            'Configure queuing mechanisms',
            'Prioritize real-time traffic',
            'Enable buffer tuning'
          ]
        });
      }
    }

    // Check packet loss
    for (const [dest, loss] of Object.entries(metrics.packetLoss)) {
      if (loss > 1) {
        optimizations.push({
          type: 'reduce_packet_loss',
          priority: 'high',
          description: `Packet loss detected to ${dest} (${loss.toFixed(2)}%). ` +
                      'Investigate link quality, buffer overflows, or hardware issues.',
          impact: 'high',
          estimatedImprovement: loss * 2,
          destination: dest,
          actions: [
            'Check link quality and errors',
            'Increase buffer sizes',
            'Investigate hardware issues',
            'Verify cable integrity'
          ]
        });
      }
    }

    // Check QoS violations
    for (const [cls, count] of Object.entries(metrics.qosViolations)) {
      if (count > 0) {
        optimizations.push({
          type: 'optimize_qos',
          priority: 'medium',
          description: `QoS violations in class ${cls} (${count} violations). ` +
                      'Adjust bandwidth allocations or review QoS policy configuration.',
          impact: 'medium',
          estimatedImprovement: 10,
          class: cls,
          actions: [
            'Adjust bandwidth allocation',
            'Review QoS policy configuration',
            'Check for misclassified traffic',
            'Verify priority settings'
          ]
        });
      }
    }

    // Check traffic imbalance
    if (metrics.trafficImbalance > this.config.traffic_balancing.imbalance_threshold) {
      optimizations.push({
        type: 'balance_traffic',
        priority: 'medium',
        description: `Traffic imbalance detected (${metrics.trafficImbalance.toFixed(1)}%). ` +
                    'Distribute load across interfaces using ECMP or adjust routing weights.',
        impact: 'medium',
        estimatedImprovement: Math.min(15, metrics.trafficImbalance / 2),
        actions: [
          'Enable ECMP (Equal-Cost Multi-Path)',
          'Adjust interface routing weights',
          'Implement traffic engineering',
          'Review load balancing algorithm'
        ]
      });
    }

    // Check overall efficiency
    if (metrics.efficiencyScore < 70) {
      optimizations.push({
        type: 'general_optimization',
        priority: 'high',
        description: `Overall efficiency score is low (${metrics.efficiencyScore.toFixed(1)}). ` +
                    'Comprehensive optimization recommended.',
        impact: 'high',
        estimatedImprovement: 100 - metrics.efficiencyScore,
        actions: [
          'Review all optimization recommendations',
          'Perform full system audit',
          'Consider hardware upgrade',
          'Implement all recommended changes'
        ]
      });
    }

    // Sort by priority and estimated improvement
    optimizations.sort((a, b) => {
      const priorityOrder = { 'high': 3, 'medium': 2, 'low': 1 };
      const priorityDiff = priorityOrder[b.priority] - priorityOrder[a.priority];
      if (priorityDiff !== 0) return priorityDiff;
      return b.estimatedImprovement - a.estimatedImprovement;
    });

    // Store in history
    if (optimizations.length > 0) {
      this.optimizationHistory.push({
        timestamp: new Date().toISOString(),
        metrics: metrics,
        optimizations: optimizations
      });

      if (this.optimizationHistory.length > 100) {
        this.optimizationHistory.shift();
      }
    }

    return optimizations;
  }

  async applyOptimization(optimization) {
    this.logger.info(`Applying optimization: ${optimization.type}`);

    try {
      // Simulate optimization application
      // In real implementation, this would use NETCONF/RESTCONF to apply changes

      const result = await this.simulateOptimization(optimization);

      if (result.success) {
        this.appliedOptimizations.push({
          timestamp: new Date().toISOString(),
          optimization: optimization,
          result: result
        });

        this.logger.info(`Optimization ${optimization.type} applied successfully: ${result.message}`);
        return true;
      } else {
        this.logger.error(`Failed to apply optimization ${optimization.type}: ${result.message}`);
        return false;
      }

    } catch (error) {
      this.logger.error(`Error applying optimization ${optimization.type}: ${error.message}`);
      return false;
    }
  }

  async simulateOptimization(optimization) {
    // Simulate the application of optimization
    // In real implementation, this would execute actual configuration changes

    markSimulated('agent4.applyOptimization', this.logger);
    const delay = Math.random() * 1000 + 500;
    await new Promise(resolve => setTimeout(resolve, delay));

    // Simulate success most of the time
    const success = Math.random() > 0.1;

    if (success) {
      return {
        success: true,
        message: `${optimization.type} optimization applied. ` +
                `Estimated improvement: ${optimization.estimatedImprovement.toFixed(1)}%`,
        timestamp: new Date().toISOString()
      };
    } else {
      return {
        success: false,
        message: `Failed to apply ${optimization.type} due to configuration error`,
        timestamp: new Date().toISOString()
      };
    }
  }

  getOptimizationHistory(limit = 10) {
    return this.optimizationHistory.slice(-limit);
  }

  getAppliedOptimizations(limit = 10) {
    return this.appliedOptimizations.slice(-limit);
  }

  getOptimizationSummary() {
    const total = this.optimizationHistory.length;
    const applied = this.appliedOptimizations.length;
    
    const byType = {};
    this.appliedOptimizations.forEach(opt => {
      const type = opt.optimization.type;
      byType[type] = (byType[type] || 0) + 1;
    });

    return {
      totalRecommendations: total,
      totalApplied: applied,
      successRate: total > 0 ? (applied / total * 100).toFixed(2) + '%' : '0%',
      byType: byType
    };
  }
}

module.exports = OptimizationEngine;