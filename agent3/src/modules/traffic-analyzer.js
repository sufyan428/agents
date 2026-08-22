/**
 * Traffic Analysis Module
 * 
 * Analyzes network traffic patterns to detect:
 * - Traffic anomalies and spikes
 * - DDoS patterns
 * - Port scanning
 * - Unusual protocol usage
 */

class TrafficAnalyzer {
  constructor(config, logger, metrics, alertDispatcher) {
    this.config = config;
    this.logger = logger;
    this.metrics = metrics;
    this.alertDispatcher = alertDispatcher;

    // Traffic baseline data
    this.baseline = {
      established: false,
      samples: [],
      statistics: {
        mean: 0,
        stdDev: 0,
        min: Infinity,
        max: -Infinity
      }
    };

    // Current traffic data
    this.currentTraffic = {
      bytes: 0,
      packets: 0,
      connections: 0,
      protocolCounts: {},
      portCounts: {},
      sourceIpCounts: {}
    };

    // Historical traffic data for trend analysis
    this.history = [];
    this.maxHistorySize = 1000;

    // Monitoring interval
    this.monitoringInterval = null;
  }

  /**
   * Start traffic monitoring
   */
  async start() {
    this.logger.info('Starting traffic analyzer');

    // Start periodic traffic analysis
    this.monitoringInterval = setInterval(() => {
      this.analyzeTraffic();
    }, this.config.monitoring_interval * 1000);

    this.logger.info('Traffic analyzer started', {
      interval_seconds: this.config.monitoring_interval
    });
  }

  /**
   * Stop traffic monitoring
   */
  async stop() {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
    }

    this.logger.info('Traffic analyzer stopped');
  }

  /**
   * Process traffic data from various sources
   * @param {Object} trafficData - Traffic data to analyze
   */
  processTrafficData(trafficData) {
    try {
      const { protocol, bytes, packets, sourceIp, destinationPort } = trafficData;

      // Update current traffic counters
      this.currentTraffic.bytes += bytes || 0;
      this.currentTraffic.packets += packets || 0;
      this.currentTraffic.connections++;

      // Track protocol usage
      if (protocol) {
        const protocolLower = protocol.toLowerCase();
        this.currentTraffic.protocolCounts[protocolLower] = 
          (this.currentTraffic.protocolCounts[protocolLower] || 0) + 1;
      }

      // Track port usage (potential port scan detection)
      if (destinationPort) {
        this.currentTraffic.portCounts[destinationPort] = 
          (this.currentTraffic.portCounts[destinationPort] || 0) + 1;
      }

      // Track source IP (potential DDoS or scanning detection)
      if (sourceIp) {
        this.currentTraffic.sourceIpCounts[sourceIp] = 
          (this.currentTraffic.sourceIpCounts[sourceIp] || 0) + 1;
      }

      // Update metrics
      this.metrics.recordTraffic(
        protocol || 'unknown',
        'ingress',
        bytes || 0,
        packets || 0
      );

    } catch (error) {
      this.logger.error('Error processing traffic data:', error);
    }
  }

  /**
   * Analyze current traffic for anomalies
   */
  async analyzeTraffic() {
    const startTime = Date.now();

    try {
      this.logger.debug('Analyzing traffic patterns', {
        bytes: this.currentTraffic.bytes,
        packets: this.currentTraffic.packets,
        connections: this.currentTraffic.connections
      });

      // Check if baseline is established
      if (!this.baseline.established) {
        await this.updateBaseline();
        return;
      }

      // Check for traffic anomalies
      await this.checkTrafficAnomalies();

      // Check for port scanning
      await this.checkPortScanning();

      // Check for DDoS patterns
      await this.checkDdosPatterns();

      // Check for unusual protocol usage
      await this.checkUnusualProtocols();

      // Add to history
      this.addToHistory();

      // Reset current traffic counters
      this.resetCurrentTraffic();

      // Record check duration
      const duration = (Date.now() - startTime) / 1000;
      this.metrics.recordCheckDuration('traffic_analysis', duration);

    } catch (error) {
      this.logger.error('Error analyzing traffic:', error);
    }
  }

  /**
   * Update traffic baseline
   */
  async updateBaseline() {
    try {
      const trafficValue = this.currentTraffic.bytes;

      // Add sample to baseline
      this.baseline.samples.push(trafficValue);

      this.logger.debug('Updating baseline', {
        sample_count: this.baseline.samples.length,
        required_samples: this.config.baseline_samples,
        current_value: trafficValue
      });

      // Check if we have enough samples
      if (this.baseline.samples.length >= this.config.baseline_samples) {
        this.calculateBaselineStatistics();
        this.baseline.established = true;

        this.logger.info('Traffic baseline established', {
          mean: this.baseline.statistics.mean,
          std_dev: this.baseline.statistics.stdDev,
          min: this.baseline.statistics.min,
          max: this.baseline.statistics.max,
          samples: this.baseline.samples.length
        });
      }

    } catch (error) {
      this.logger.error('Error updating baseline:', error);
    }
  }

  /**
   * Calculate baseline statistics
   */
  calculateBaselineStatistics() {
    const samples = this.baseline.samples;

    // Calculate mean
    const sum = samples.reduce((a, b) => a + b, 0);
    this.baseline.statistics.mean = sum / samples.length;

    // Calculate standard deviation
    const squaredDiffs = samples.map(value => Math.pow(value - this.baseline.statistics.mean, 2));
    const avgSquaredDiff = squaredDiffs.reduce((a, b) => a + b, 0) / samples.length;
    this.baseline.statistics.stdDev = Math.sqrt(avgSquaredDiff);

    // Calculate min and max
    this.baseline.statistics.min = Math.min(...samples);
    this.baseline.statistics.max = Math.max(...samples);
  }

  /**
   * Check for traffic anomalies
   */
  async checkTrafficAnomalies() {
    const currentBytes = this.currentTraffic.bytes;
    const mean = this.baseline.statistics.mean;
    const stdDev = this.baseline.statistics.stdDev;

    // Calculate z-score (number of standard deviations from mean)
    const zScore = stdDev > 0 ? (currentBytes - mean) / stdDev : 0;
    const absZScore = Math.abs(zScore);

    this.logger.debug('Traffic anomaly check', {
      current_bytes: currentBytes,
      mean: mean,
      std_dev: stdDev,
      z_score: zScore,
      threshold: this.config.anomaly_threshold
    });

    // Check if anomaly threshold exceeded
    if (absZScore > this.config.anomaly_threshold) {
      const severity = absZScore > this.config.anomaly_threshold * 2 ? 'critical' : 'high';
      const anomalyType = zScore > 0 ? 'traffic_spike' : 'traffic_drop';

      this.logger.warn('Traffic anomaly detected', {
        type: anomalyType,
        current_bytes: currentBytes,
        expected_mean: mean,
        z_score: zScore,
        severity: severity
      });

      // Record anomaly
      this.metrics.recordTrafficAnomaly(anomalyType, severity);

      // Dispatch alert
      this.alertDispatcher.dispatchAlert({
        type: 'traffic_anomaly',
        severity: severity,
        title: `Traffic ${anomalyType === 'traffic_spike' ? 'Spike' : 'Drop'} Detected`,
        description: `Traffic is ${absZScore.toFixed(2)} standard deviations ${zScore > 0 ? 'above' : 'below'} the baseline`,
        details: {
          anomaly_type: anomalyType,
          current_bytes: currentBytes,
          expected_mean: mean,
          z_score: zScore.toFixed(2),
          threshold: this.config.anomaly_threshold,
          recommended_action: anomalyType === 'traffic_spike'
            ? 'Investigate potential DDoS attack or misconfiguration'
            : 'Check for network issues or service disruption',
          timestamp: new Date().toISOString()
        }
      });
    }

    // Check for traffic spike (absolute threshold)
    const spikeMultiplier = currentBytes / mean;
    if (spikeMultiplier > this.config.spike_threshold) {
      this.logger.error('Severe traffic spike detected', {
        current_bytes: currentBytes,
        expected_mean: mean,
        spike_multiplier: spikeMultiplier.toFixed(2)
      });

      this.metrics.recordTrafficAnomaly('severe_spike', 'critical');

      this.alertDispatcher.dispatchAlert({
        type: 'traffic_spike',
        severity: 'critical',
        title: 'Severe Traffic Spike Detected',
        description: `Traffic is ${spikeMultiplier.toFixed(2)}x higher than normal`,
        details: {
          current_bytes: currentBytes,
          expected_mean: mean,
          spike_multiplier: spikeMultiplier.toFixed(2),
          recommended_action: 'Immediate investigation required. Possible DDoS attack.',
          timestamp: new Date().toISOString()
        }
      });
    }
  }

  /**
   * Check for port scanning patterns
   */
  async checkPortScanning() {
    const portEntries = Object.entries(this.currentTraffic.portCounts);

    // Check for IPs accessing many different ports
    for (const [sourceIp, portCount] of Object.entries(this.currentTraffic.sourceIpCounts)) {
      // Count unique ports accessed by this IP
      // Not yet consulted by any check below; kept as the shape a real
      // per-IP port analysis would need. See the capability matrix.
      const _uniquePorts = portEntries.filter(([_port, count]) => {
        // This is a simplified check - in production, you'd track which IPs accessed which ports
        return count > 0;
      }).length;

      // Check if accessing many ports (potential port scan)
      if (portCount > 100) {
        this.logger.warn('Potential port scan detected', {
          source_ip: sourceIp,
          connection_count: portCount
        });

        const severity = portCount > 500 ? 'critical' : 'high';

        // Record port scan
        this.metrics.recordPortScan(sourceIp, 'port_scan');

        // Dispatch alert
        this.alertDispatcher.dispatchAlert({
          type: 'port_scan',
          severity: severity,
          title: 'Potential Port Scan Detected',
          description: `IP ${sourceIp} made ${portCount} connections to various ports`,
          details: {
            source_ip: sourceIp,
            connection_count: portCount,
            recommended_action: 'Investigate and consider blocking IP if malicious',
            timestamp: new Date().toISOString()
          }
        });
      }
    }
  }

  /**
   * Check for DDoS patterns
   */
  async checkDdosPatterns() {
    const sourceIpEntries = Object.entries(this.currentTraffic.sourceIpCounts);

    // Check for IPs with unusually high connection counts
    const _maxConnections = Math.max(...Object.values(this.currentTraffic.sourceIpCounts), 0);

    for (const [sourceIp, connectionCount] of sourceIpEntries) {
      // Check if this IP has a disproportionate amount of traffic
      const percentageOfTotal = (connectionCount / this.currentTraffic.connections) * 100;

      if (percentageOfTotal > 50) {
        this.logger.error('Potential DDoS source detected', {
          source_ip: sourceIp,
          connection_count: connectionCount,
          percentage_of_total: percentageOfTotal.toFixed(2)
        });

        // Record threat
        this.metrics.recordThreat('ddos_attack', 'critical');

        // Dispatch alert
        this.alertDispatcher.dispatchAlert({
          type: 'ddos_attack',
          severity: 'critical',
          title: 'Potential DDoS Attack Detected',
          description: `IP ${sourceIp} accounts for ${percentageOfTotal.toFixed(2)}% of total traffic`,
          details: {
            source_ip: sourceIp,
            connection_count: connectionCount,
            percentage_of_total: percentageOfTotal.toFixed(2),
            recommended_action: 'Immediate action required. Consider rate limiting or blocking IP.',
            timestamp: new Date().toISOString()
          }
        });
      }
    }

    // Check for distributed attack pattern (many IPs with moderate traffic)
    const highVolumeIps = sourceIpEntries.filter(([_ip, count]) => count > 50);
    if (highVolumeIps.length > 20) {
      this.logger.error('Potential distributed DDoS attack detected', {
        high_volume_ips: highVolumeIps.length,
        threshold: 20
      });

      this.metrics.recordThreat('distributed_ddos', 'critical');

      this.alertDispatcher.dispatchAlert({
        type: 'distributed_ddos',
        severity: 'critical',
        title: 'Potential Distributed DDoS Attack Detected',
        description: `${highVolumeIps.length} different IPs are generating high traffic volumes`,
        details: {
          high_volume_ips: highVolumeIps.length,
          source_ips: highVolumeIps.map(([ip]) => ip),
          recommended_action: 'Critical: Implement rate limiting and DDoS mitigation immediately',
          timestamp: new Date().toISOString()
        }
      });
    }
  }

  /**
   * Check for unusual protocol usage
   */
  async checkUnusualProtocols() {
    const totalConnections = this.currentTraffic.connections;
    const protocolEntries = Object.entries(this.currentTraffic.protocolCounts);

    // Check for protocols that are typically not used in normal operation
    const suspiciousProtocols = ['tftp', 'ftp', 'telnet', 'rsh', 'rlogin', 'finger'];

    for (const [protocol, count] of protocolEntries) {
      const protocolLower = protocol.toLowerCase();

      if (suspiciousProtocols.includes(protocolLower) && count > 0) {
        this.logger.warn('Suspicious protocol usage detected', {
          protocol: protocol,
          connection_count: count
        });

        this.metrics.recordThreat('unusual_protocol', 'high');

        this.alertDispatcher.dispatchAlert({
          type: 'unusual_protocol',
          severity: 'high',
          title: 'Suspicious Protocol Usage Detected',
          description: `Detected usage of potentially dangerous protocol: ${protocol}`,
          details: {
            protocol: protocol,
            connection_count: count,
            recommended_action: 'Investigate protocol usage and block if unauthorized',
            timestamp: new Date().toISOString()
          }
        });
      }
    }

    // Check for protocols with unusual dominance
    for (const [protocol, count] of protocolEntries) {
      const percentage = (count / totalConnections) * 100;

      if (percentage > 90 && count > 100) {
        this.logger.warn('Unusual protocol dominance detected', {
          protocol: protocol,
          percentage: percentage.toFixed(2)
        });

        this.metrics.recordTrafficAnomaly('protocol_dominance', 'medium');

        this.alertDispatcher.dispatchAlert({
          type: 'protocol_anomaly',
          severity: 'medium',
          title: 'Unusual Protocol Dominance Detected',
          description: `Protocol ${protocol} accounts for ${percentage.toFixed(2)}% of all traffic`,
          details: {
            protocol: protocol,
            percentage: percentage.toFixed(2),
            recommended_action: 'Investigate if this is expected behavior',
            timestamp: new Date().toISOString()
          }
        });
      }
    }
  }

  /**
   * Add current traffic data to history
   */
  addToHistory() {
    const historyEntry = {
      timestamp: new Date().toISOString(),
      bytes: this.currentTraffic.bytes,
      packets: this.currentTraffic.packets,
      connections: this.currentTraffic.connections,
      protocols: { ...this.currentTraffic.protocolCounts },
      ports: { ...this.currentTraffic.portCounts },
      sourceIps: { ...this.currentTraffic.sourceIpCounts }
    };

    this.history.push(historyEntry);

    // Maintain history size limit
    if (this.history.length > this.maxHistorySize) {
      this.history.shift();
    }
  }

  /**
   * Reset current traffic counters
   */
  resetCurrentTraffic() {
    this.currentTraffic = {
      bytes: 0,
      packets: 0,
      connections: 0,
      protocolCounts: {},
      portCounts: {},
      sourceIpCounts: {}
    };
  }

  /**
   * Get current statistics
   */
  getStatistics() {
    return {
      baseline: {
        established: this.baseline.established,
        samples_count: this.baseline.samples.length,
        statistics: this.baseline.statistics
      },
      current_traffic: this.currentTraffic,
      history_size: this.history.length
    };
  }

  /**
   * Reset baseline (useful for testing or when network patterns change)
   */
  resetBaseline() {
    this.baseline = {
      established: false,
      samples: [],
      statistics: {
        mean: 0,
        stdDev: 0,
        min: Infinity,
        max: -Infinity
      }
    };

    this.logger.info('Traffic baseline reset');
  }
}

module.exports = TrafficAnalyzer;