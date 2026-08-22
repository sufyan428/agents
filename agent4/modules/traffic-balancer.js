const { declareSimulated, markSimulated } = require('@ragent/agent-common');

declareSimulated(
  'agent4.trafficDistribution',
  'Generates per-link traffic volumes rather than reading interface counters.',
  'interface counter deltas from SNMP, or flow data'
);

const winston = require('winston');

class TrafficBalancer {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.interfaceHistory = [];
    this.previousAnalysis = null;
  }

  async analyzeTraffic() {
    const metrics = {
      interfaces: [],
      imbalance: 0,
      totalTraffic: 0,
      recommendation: null,
      timestamp: new Date().toISOString()
    };

    try {
      // Simulate interface traffic data
      // In real implementation, this would come from SNMP monitoring
      const interfaces = this.getSimulatedInterfaces();

      // Calculate traffic distribution
      const trafficData = this.calculateTrafficDistribution(interfaces);
      metrics.interfaces = trafficData.interfaces;
      metrics.totalTraffic = trafficData.totalTraffic;
      metrics.imbalance = trafficData.imbalance;

      // Generate recommendation
      metrics.recommendation = this.generateRecommendation(trafficData);

      // Store for historical comparison
      this.interfaceHistory.push(trafficData);
      if (this.interfaceHistory.length > 10) {
        this.interfaceHistory.shift();
      }

      this.previousAnalysis = metrics;

      this.logger.info(`Traffic analysis: ${metrics.interfaces.length} interfaces, ` +
                      `imbalance=${metrics.imbalance.toFixed(2)}%, ` +
                      `recommendation=${metrics.recommendation?.type || 'none'}`);

    } catch (error) {
      this.logger.error(`Error analyzing traffic: ${error.message}`);
    }

    return metrics;
  }

  getSimulatedInterfaces() {
    // Simulate interface traffic data
    const interfaces = [];
    const interfaceCount = 3;

    for (let i = 1; i <= interfaceCount; i++) {
      markSimulated('agent4.trafficDistribution', this.logger);
      const baseTraffic = Math.floor(Math.random() * 500000) + 300000;
      const variance = Math.floor(Math.random() * 200000);

      interfaces.push({
        index: i.toString(),
        name: `GigabitEthernet0/${i - 1}`,
        inOctets: baseTraffic + variance,
        outOctets: baseTraffic + variance,
        status: 1,
        maxBandwidth: 1000000000 // 1 Gbps
      });
    }

    return interfaces;
  }

  calculateTrafficDistribution(interfaces) {
    const totalTraffic = interfaces.reduce((sum, iface) => {
      return sum + iface.inOctets + iface.outOctets;
    }, 0);

    const interfaceTraffic = interfaces.map(iface => ({
      ...iface,
      totalOctets: iface.inOctets + iface.outOctets,
      percentage: totalTraffic > 0 
        ? ((iface.inOctets + iface.outOctets) / totalTraffic * 100)
        : 0
    }));

    // Calculate imbalance (max - min percentage)
    const percentages = interfaceTraffic.map(iface => iface.percentage);
    const maxPercent = Math.max(...percentages);
    const minPercent = Math.min(...percentages);
    const imbalance = maxPercent - minPercent;

    return {
      interfaces: interfaceTraffic,
      totalTraffic: totalTraffic,
      imbalance: imbalance
    };
  }

  generateRecommendation(trafficData) {
    const threshold = this.config.traffic_balancing.imbalance_threshold || 30;

    if (trafficData.imbalance > threshold) {
      // Find overloaded and underutilized interfaces
      const sorted = [...trafficData.interfaces].sort((a, b) => b.percentage - a.percentage);
      const overloaded = sorted[0];
      const underutilized = sorted[sorted.length - 1];

      return {
        type: 'rebalance_traffic',
        description: `Traffic imbalance detected (${trafficData.imbalance.toFixed(1)}%). ` +
                    `Rebalance from ${overloaded.name} (${overloaded.percentage.toFixed(1)}%) ` +
                    `to ${underutilized.name} (${underutilized.percentage.toFixed(1)}%)`,
        severity: 'medium',
        details: {
          imbalance: trafficData.imbalance,
          overloadedInterface: overloaded.name,
          underutilizedInterface: underutilized.name,
          suggestedAction: 'Adjust routing weights or enable ECMP'
        },
        timestamp: new Date().toISOString()
      };
    }

    return null;
  }

  getHistoricalData() {
    return this.interfaceHistory;
  }

  getPreviousAnalysis() {
    return this.previousAnalysis;
  }
}

module.exports = TrafficBalancer;