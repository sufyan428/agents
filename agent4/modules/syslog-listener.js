const dgram = require('dgram');

class SyslogListener {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.server = null;
    this.messageHandler = null;
    this.messageCount = 0;
    this.errorCount = 0;
    this.messageBuffer = [];
    this.maxBufferSize = 1000;
  }

  start() {
    return new Promise((resolve, reject) => {
      try {
        this.server = dgram.createSocket('udp4');

        this.server.on('message', (msg, rinfo) => {
          this.handleMessage(msg, rinfo);
        });

        this.server.on('error', (err) => {
          this.errorCount++;
          this.logger.error(`Syslog server error: ${err.message}`);
        });

        this.server.on('listening', () => {
          const address = this.server.address();
          this.logger.info(`Syslog listener listening on ${address.address}:${address.port}`);
          resolve();
        });

        this.server.bind(
          this.config.syslog.port,
          this.config.syslog.bind_host
        );

      } catch (error) {
        reject(error);
      }
    });
  }

  handleMessage(msg, rinfo) {
    try {
      const message = msg.toString('utf8');
      this.messageCount++;

      // Parse syslog message
      const parsed = this.parseSyslogMessage(message, rinfo);

      // Add to buffer
      this.messageBuffer.push(parsed);

      // Maintain buffer size
      if (this.messageBuffer.length > this.maxBufferSize) {
        this.messageBuffer.shift();
      }

      // Log important events
      if (this.isCriticalEvent(parsed)) {
        this.logger.warn(`Critical syslog event from ${rinfo.address}: ${message}`);
      }

      this.logger.debug(`Received syslog from ${rinfo.address}: ${message}`);

    } catch (error) {
      this.logger.error(`Error handling syslog message: ${error.message}`);
    }
  }

  parseSyslogMessage(message, rinfo) {
    // Simple syslog parser
    const parts = message.split(' ');

    const parsed = {
      raw: message,
      source: rinfo.address,
      timestamp: new Date().toISOString(),
      priority: 0,
      facility: 0,
      severity: 0,
      message: ''
    };

    // Try to parse RFC3164 format (BSD syslog)
    if (parts.length >= 3) {
      const priorityMatch = message.match(/^<(\d+)>/);
      
      if (priorityMatch) {
        parsed.priority = parseInt(priorityMatch[1]);
        parsed.facility = Math.floor(parsed.priority / 8);
        parsed.severity = parsed.priority % 8;

        // Extract message content
        const messageContent = message.substring(priorityMatch[0].length).trim();
        parsed.message = messageContent;
      } else {
        parsed.message = message;
      }
    } else {
      parsed.message = message;
    }

    // Check for performance-related keywords
    parsed.performanceImpact = this.assessPerformanceImpact(parsed);

    return parsed;
  }

  assessPerformanceImpact(parsed) {
    const message = parsed.message.toLowerCase();
    const highImpact = ['congestion', 'dropped', 'timeout', 'exceeded', 'overload', 'critical'];
    const mediumImpact = ['warning', 'high', 'slow', 'delay', 'degraded'];

    if (highImpact.some(keyword => message.includes(keyword))) {
      return 'high';
    } else if (mediumImpact.some(keyword => message.includes(keyword))) {
      return 'medium';
    } else {
      return 'low';
    }
  }

  isCriticalEvent(parsed) {
    // Severity levels: 0=emerg, 1=alert, 2=crit, 3=err, 4=warn, 5=notice, 6=info, 7=debug
    if (parsed.severity <= 2) {
      return true;
    }

    // Check for performance-critical keywords
    const criticalKeywords = [
      'congestion',
      'buffer overflow',
      'queue full',
      'packet loss',
      'interface down',
      'link failure'
    ];

    return criticalKeywords.some(keyword => 
      parsed.message.toLowerCase().includes(keyword)
    );
  }

  stop() {
    if (this.server) {
      this.server.close();
      this.logger.info('Syslog listener stopped');
    }
  }

  getMessageCount() {
    return this.messageCount;
  }

  getErrorCount() {
    return this.errorCount;
  }

  getRecentMessages(limit = 100) {
    return this.messageBuffer.slice(-limit);
  }

  getCriticalEvents(limit = 50) {
    return this.messageBuffer
      .filter(m => m.performanceImpact === 'high' || m.severity <= 2)
      .slice(-limit);
  }

  clearBuffer() {
    this.messageBuffer = [];
  }
}

module.exports = SyslogListener;