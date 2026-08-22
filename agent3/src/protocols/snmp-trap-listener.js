/**
 * SNMP Trap Listener Module
 * 
 * Listens for SNMP traps from routers and processes them
 * for security events
 */

const dgram = require('dgram');

class SnmpTrapListener {
  constructor(config, logger, metrics, alertDispatcher) {
    this.config = config;
    this.logger = logger;
    this.metrics = metrics;
    this.alertDispatcher = alertDispatcher;

    this.server = null;
    this.isRunning = false;
    this.trapCount = 0;
  }

  /**
   * Start SNMP trap listener
   */
  async start() {
    return new Promise((resolve, reject) => {
      try {
        this.server = dgram.createSocket('udp4');

        this.server.on('message', (msg, rinfo) => {
          this.handleTrap(msg, rinfo);
        });

        this.server.on('error', (error) => {
          this.logger.error('SNMP trap listener error:', error);
          reject(error);
        });

        this.server.on('listening', () => {
          const address = this.server.address();
          this.logger.info('SNMP trap listener listening', {
            address: address.address,
            port: address.port
          });
          this.isRunning = true;
          resolve();
        });

        // SNMP traps typically come on port 162
        this.server.bind(162, '0.0.0.0');

      } catch (error) {
        this.logger.error('Failed to start SNMP trap listener:', error);
        reject(error);
      }
    });
  }

  /**
   * Stop SNMP trap listener
   */
  async stop() {
    if (this.server) {
      return new Promise((resolve) => {
        this.server.close(() => {
          this.isRunning = false;
          this.logger.info('SNMP trap listener stopped');
          resolve();
        });
      });
    }
  }

  /**
   * Handle incoming SNMP trap
   */
  handleTrap(msg, rinfo) {
    try {
      this.trapCount++;

      // Parse SNMP trap (simplified - in production use proper SNMP library)
      const trapData = this.parseTrap(msg, rinfo);

      // Update metrics
      this.metrics.recordSnmpTrap(trapData.type, trapData.severity);

      this.logger.debug('SNMP trap received', {
        source_ip: rinfo.address,
        source_port: rinfo.port,
        trap_type: trapData.type,
        oid: trapData.oid,
        message: trapData.message
      });

      // Process trap based on type
      this.processTrap(trapData);

    } catch (error) {
      this.logger.error('Error handling SNMP trap:', error);
    }
  }

  /**
   * Parse SNMP trap message
   */
  parseTrap(msg, rinfo) {
    // This is a simplified parser
    // In production, you would use a proper SNMP library to decode BER-encoded traps

    const trapData = {
      raw: msg,
      source_ip: rinfo.address,
      source_port: rinfo.port,
      timestamp: new Date().toISOString(),
      version: '2c',
      community: this.config.community,
      type: 'unknown',
      oid: '',
      message: '',
      severity: 'info'
    };

    // Try to extract OID and message from the trap
    const msgStr = msg.toString('ascii');

    // Look for common OIDs that indicate security events
    if (msgStr.includes('authenticationFailure') || msgStr.includes('1.3.6.1.6.3.1.1.5.5')) {
      trapData.type = 'authentication_failure';
      trapData.oid = '1.3.6.1.6.3.1.1.5.5';
      trapData.severity = 'high';
      trapData.message = 'SNMP authentication failure detected';
    }
    else if (msgStr.includes('linkDown') || msgStr.includes('1.3.6.1.2.1.2.2.1.8')) {
      trapData.type = 'link_down';
      trapData.oid = '1.3.6.1.2.1.2.2.1.8';
      trapData.severity = 'high';
      trapData.message = 'Network link went down';
    }
    else if (msgStr.includes('coldStart') || msgStr.includes('1.3.6.1.6.3.1.1.5.1')) {
      trapData.type = 'cold_start';
      trapData.oid = '1.3.6.1.6.3.1.1.5.1';
      trapData.severity = 'critical';
      trapData.message = 'Device cold start (reboot) detected';
    }
    else if (msgStr.includes('warmStart') || msgStr.includes('1.3.6.1.6.3.1.1.5.2')) {
      trapData.type = 'warm_start';
      trapData.oid = '1.3.6.1.6.3.1.1.5.2';
      trapData.severity = 'high';
      trapData.message = 'Device warm start detected';
    }
    else if (msgStr.includes('security violation') || msgStr.includes('securityViolation')) {
      trapData.type = 'security_violation';
      trapData.oid = 'unknown';
      trapData.severity = 'critical';
      trapData.message = 'Security violation detected';
    }
    else {
      // Generic trap
      trapData.type = 'generic';
      trapData.oid = 'unknown';
      trapData.message = msgStr.substring(0, 200); // Limit message length
    }

    return trapData;
  }

  /**
   * Process trap based on type
   */
  processTrap(trapData) {
    switch (trapData.type) {
      case 'authentication_failure':
        this.handleAuthenticationFailure(trapData);
        break;

      case 'link_down':
        this.handleLinkDown(trapData);
        break;

      case 'cold_start':
        this.handleColdStart(trapData);
        break;

      case 'warm_start':
        this.handleWarmStart(trapData);
        break;

      case 'security_violation':
        this.handleSecurityViolation(trapData);
        break;

      default:
        this.handleGenericTrap(trapData);
    }
  }

  /**
   * Handle authentication failure trap
   */
  handleAuthenticationFailure(trapData) {
    this.logger.warn('SNMP authentication failure detected', {
      source_ip: trapData.source_ip,
      timestamp: trapData.timestamp
    });

    this.alertDispatcher.dispatchAlert({
      type: 'snmp_auth_failure',
      severity: 'high',
      title: 'SNMP Authentication Failure',
      description: `SNMP authentication failure detected from ${trapData.source_ip}`,
      details: {
        source_ip: trapData.source_ip,
        oid: trapData.oid,
        message: trapData.message,
        recommended_action: 'Investigate source and verify SNMP community string configuration',
        timestamp: trapData.timestamp
      }
    });
  }

  /**
   * Handle link down trap
   */
  handleLinkDown(trapData) {
    this.logger.warn('Network link down detected', {
      source_ip: trapData.source_ip,
      timestamp: trapData.timestamp
    });

    this.alertDispatcher.dispatchAlert({
      type: 'link_down',
      severity: 'high',
      title: 'Network Link Down',
      description: `Network interface on ${trapData.source_ip} went down`,
      details: {
        source_ip: trapData.source_ip,
        oid: trapData.oid,
        message: trapData.message,
        recommended_action: 'Check network connectivity and interface status',
        timestamp: trapData.timestamp
      }
    });
  }

  /**
   * Handle cold start trap
   */
  handleColdStart(trapData) {
    this.logger.error('Device cold start detected', {
      source_ip: trapData.source_ip,
      timestamp: trapData.timestamp
    });

    this.alertDispatcher.dispatchAlert({
      type: 'device_reboot',
      severity: 'critical',
      title: 'Device Reboot Detected',
      description: `Device ${trapData.source_ip} has been restarted (cold start)`,
      details: {
        source_ip: trapData.source_ip,
        oid: trapData.oid,
        message: trapData.message,
        recommended_action: 'Verify if reboot was authorized. Investigate cause of restart.',
        timestamp: trapData.timestamp
      }
    });
  }

  /**
   * Handle warm start trap
   */
  handleWarmStart(trapData) {
    this.logger.warn('Device warm start detected', {
      source_ip: trapData.source_ip,
      timestamp: trapData.timestamp
    });

    this.alertDispatcher.dispatchAlert({
      type: 'device_restart',
      severity: 'high',
      title: 'Device Restart Detected',
      description: `Device ${trapData.source_ip} has been restarted (warm start)`,
      details: {
        source_ip: trapData.source_ip,
        oid: trapData.oid,
        message: trapData.message,
        recommended_action: 'Verify if restart was authorized',
        timestamp: trapData.timestamp
      }
    });
  }

  /**
   * Handle security violation trap
   */
  handleSecurityViolation(trapData) {
    this.logger.error('Security violation detected via SNMP', {
      source_ip: trapData.source_ip,
      timestamp: trapData.timestamp
    });

    this.alertDispatcher.dispatchAlert({
      type: 'security_violation',
      severity: 'critical',
      title: 'Security Violation Detected',
      description: `Security violation detected on ${trapData.source_ip}`,
      details: {
        source_ip: trapData.source_ip,
        oid: trapData.oid,
        message: trapData.message,
        recommended_action: 'IMMEDIATE INVESTIGATION REQUIRED',
        timestamp: trapData.timestamp
      }
    });
  }

  /**
   * Handle generic trap
   */
  handleGenericTrap(trapData) {
    this.logger.debug('Generic SNMP trap received', {
      source_ip: trapData.source_ip,
      message: trapData.message
    });

    // Log informational traps without alerting
    this.logger.info('SNMP trap', {
      type: trapData.type,
      source_ip: trapData.source_ip,
      message: trapData.message
    });
  }

  /**
   * Check if listener is running
   */
  isRunning() {
    return this.isRunning;
  }

  /**
   * Get statistics
   */
  getStatistics() {
    return {
      running: this.isRunning,
      traps_received: this.trapCount,
      port: 162
    };
  }
}

module.exports = SnmpTrapListener;