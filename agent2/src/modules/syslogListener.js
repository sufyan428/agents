const dgram = require('dgram');

class SyslogListener {
  constructor(config, logger, metrics) {
    this.config = config;
    this.logger = logger;
    this.metrics = metrics;
    
    this.server = null;
    this.port = config.syslog?.port || 514;
    this.protocol = config.syslog?.protocol || 'udp';
    this.messageCount = 0;
    this.errorCount = 0;
  }

  start() {
    if (!this.config.syslog?.enabled) {
      this.logger.info('Syslog listener is disabled');
      return;
    }

    if (this.protocol === 'udp') {
      this.startUDPListener();
    } else if (this.protocol === 'tcp') {
      this.startTCPListener();
    } else {
      this.logger.error(`Unsupported syslog protocol: ${this.protocol}`);
    }
  }

  startUDPListener() {
    this.server = dgram.createSocket('udp4');

    this.server.on('message', (msg, rinfo) => {
      this.handleMessage(msg, rinfo);
    });

    this.server.on('error', (err) => {
      this.logger.error('Syslog UDP server error', {
        error: err.message
      });
      this.errorCount++;
    });

    this.server.on('listening', () => {
      const address = this.server.address();
      this.logger.info('Syslog UDP server listening', {
        address: address.address,
        port: address.port
      });
    });

    this.server.bind(this.port);
  }

  startTCPListener() {
    const net = require('net');
    
    this.server = net.createServer((socket) => {
      socket.on('data', (data) => {
        this.handleMessage(data, {
          address: socket.remoteAddress,
          port: socket.remotePort
        });
      });

      socket.on('error', (err) => {
        this.logger.error('Syslog TCP socket error', {
          error: err.message
        });
        this.errorCount++;
      });
    });

    this.server.listen(this.port, () => {
      this.logger.info('Syslog TCP server listening', {
        port: this.port
      });
    });
  }

  handleMessage(msg, rinfo) {
    try {
      const message = msg.toString('utf8');
      this.messageCount++;

      const parsed = this.parseSyslogMessage(message);
      
      this.logger.debug('Syslog message received', {
        source: rinfo.address,
        port: rinfo.port,
        parsed
      });

      // Check if message is from our routers
      if (this.isFromRouter(rinfo.address)) {
        this.processRouterSyslog(parsed, rinfo.address);
      }

      // Process the message based on severity
      if (parsed.severity <= 2) { // Emergency, Alert, Critical
        this.handleCriticalSyslog(parsed, rinfo.address);
      }

    } catch (error) {
      this.logger.error('Failed to process syslog message', {
        error: error.message,
        message: msg.toString('utf8')
      });
      this.errorCount++;
    }
  }

  parseSyslogMessage(message) {
    // RFC3164 format: <priority>timestamp hostname tag: message
    // RFC5424 format: <priority>version timestamp hostname app-name procid msgid structured-data message
    
    const priorityMatch = message.match(/^<(\d+)>(.*)/);
    if (!priorityMatch) {
      return {
        raw: message,
        priority: 0,
        facility: 0,
        severity: 0,
        message: message
      };
    }

    const priority = parseInt(priorityMatch[1], 10);
    const facility = Math.floor(priority / 8);
    const severity = priority % 8;
    const remainder = priorityMatch[2];

    // Try to parse RFC5424 format
    const rfc5424Match = remainder.match(/^(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.*)/);
    if (rfc5424Match) {
      return {
        raw: message,
        version: parseInt(rfc5424Match[1], 10),
        timestamp: rfc5424Match[2],
        hostname: rfc5424Match[3],
        appName: rfc5424Match[4],
        procId: rfc5424Match[5],
        msgId: rfc5424Match[6],
        structuredData: rfc5424Match[7],
        message: remainder,
        priority,
        facility,
        severity
      };
    }

    // Try to parse RFC3164 format
    const rfc3164Match = remainder.match(/^(\S{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2})\s+(\S+)\s+(\S+):\s*(.*)/);
    if (rfc3164Match) {
      return {
        raw: message,
        timestamp: rfc3164Match[1],
        hostname: rfc3164Match[2],
        tag: rfc3164Match[3],
        message: rfc3164Match[4],
        priority,
        facility,
        severity
      };
    }

    // Fallback: basic parsing
    return {
      raw: message,
      message: remainder,
      priority,
      facility,
      severity
    };
  }

  isFromRouter(address) {
    const primaryHost = this.config.primary?.host;
    const backupHost = this.config.backup?.host;
    
    return address === primaryHost || address === backupHost;
  }

  processRouterSyslog(parsed, address) {
    const routerType = address === this.config.primary?.host ? 'primary' : 'backup';
    
    this.logger.info(`Router syslog from ${routerType}`, {
      host: address,
      severity: parsed.severity,
      message: parsed.message
    });

    // Check for router-specific events
    if (this.isFailoverEvent(parsed)) {
      this.handleRouterFailoverEvent(parsed, routerType);
    }

    if (this.isInterfaceDownEvent(parsed)) {
      this.handleInterfaceDownEvent(parsed, routerType);
    }

    if (this.isConfigurationChangeEvent(parsed)) {
      this.handleConfigurationChangeEvent(parsed, routerType);
    }
  }

  isFailoverEvent(parsed) {
    const failoverKeywords = [
      'failover',
      'redundancy',
      'standby',
      'vrrp',
      'hsrp'
    ];
    
    const message = parsed.message.toLowerCase();
    return failoverKeywords.some(keyword => message.includes(keyword));
  }

  isInterfaceDownEvent(parsed) {
    const interfaceKeywords = [
      'interface.*down',
      'link.*down',
      'port.*down',
      'connection.*lost'
    ];
    
    const message = parsed.message.toLowerCase();
    return interfaceKeywords.some(keyword => message.match(keyword));
  }

  isConfigurationChangeEvent(parsed) {
    const configKeywords = [
      'config.*changed',
      'configuration.*modified',
      'startup-config',
      'running-config'
    ];
    
    const message = parsed.message.toLowerCase();
    return configKeywords.some(keyword => message.includes(keyword));
  }

  handleCriticalSyslog(parsed, address) {
    this.logger.critical('Critical syslog message', {
      source: address,
      severity: parsed.severity,
      message: parsed.message
    });

    // Could trigger alerts or additional monitoring here
    if (this.isFromRouter(address)) {
      
      // You might want to trigger additional health checks
      // or adjust monitoring thresholds based on critical events
    }
  }

  handleRouterFailoverEvent(parsed, routerType) {
    this.logger.warn(`Router failover event detected on ${routerType}`, {
      message: parsed.message
    });

    // This could be used to detect if the router itself
    // is performing failover operations
  }

  handleInterfaceDownEvent(parsed, routerType) {
    this.logger.warn(`Interface down event on ${routerType}`, {
      message: parsed.message
    });

    // Could trigger additional interface monitoring
    // or adjust routing metrics
  }

  handleConfigurationChangeEvent(parsed, routerType) {
    this.logger.info(`Configuration change detected on ${routerType}`, {
      message: parsed.message
    });

    // Could trigger config sync if needed
  }

  getStats() {
    return {
      protocol: this.protocol,
      port: this.port,
      isActive: this.server !== null,
      messageCount: this.messageCount,
      errorCount: this.errorCount
    };
  }

  stop() {
    if (this.server) {
      this.server.close();
      this.server = null;
      this.logger.info('Syslog listener stopped');
    }
  }
}

module.exports = SyslogListener;