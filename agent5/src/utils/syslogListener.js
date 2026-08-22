const dgram = require('dgram');
const logger = require('./logger');

class SyslogListener {
  constructor(config) {
    this.config = config;
    this.server = null;
    this.messages = [];
    this.maxMessages = 1000;
  }

  start() {
    if (!this.config.syslog.enabled) {
      logger.info('Syslog listener is disabled');
      return;
    }

    const protocol = this.config.syslog.protocol.toLowerCase();
    const port = this.config.syslog.port || 514;

    if (protocol === 'udp') {
      this.startUdpServer(port);
    } else if (protocol === 'tcp') {
      this.startTcpServer(port);
    } else {
      logger.error(`Unsupported syslog protocol: ${protocol}`);
    }
  }

  startUdpServer(port) {
    this.server = dgram.createSocket('udp4');

    this.server.on('message', (msg, rinfo) => {
      this.handleMessage(msg, rinfo);
    });

    this.server.on('error', (err) => {
      logger.error(`Syslog UDP server error: ${err.message}`);
    });

    this.server.on('listening', () => {
      const address = this.server.address();
      logger.info(`Syslog UDP server listening on ${address.address}:${address.port}`);
    });

    this.server.bind(port, '0.0.0.0');
    logger.info(`Started syslog UDP listener on port ${port}`);
  }

  startTcpServer(port) {
    const net = require('net');

    this.server = net.createServer((socket) => {
      socket.on('data', (msg) => {
        this.handleMessage(msg, { address: socket.remoteAddress, port: socket.remotePort });
      });

      socket.on('error', (err) => {
        logger.error(`Syslog TCP socket error: ${err.message}`);
      });
    });

    this.server.listen(port, '0.0.0.0', () => {
      const address = this.server.address();
      logger.info(`Syslog TCP server listening on ${address.address}:${address.port}`);
    });

    logger.info(`Started syslog TCP listener on port ${port}`);
  }

  handleMessage(msg, rinfo) {
    const message = msg.toString('utf8').trim();
    const timestamp = new Date().toISOString();

    const parsedMessage = this.parseSyslogMessage(message);
    
    const syslogEntry = {
      timestamp,
      source: rinfo.address,
      port: rinfo.port,
      facility: parsedMessage.facility,
      severity: parsedMessage.severity,
      priority: parsedMessage.priority,
      hostname: parsedMessage.hostname,
      tag: parsedMessage.tag,
      message: parsedMessage.message,
      raw: message
    };

    this.messages.push(syslogEntry);
    
    // Keep only the last maxMessages
    if (this.messages.length > this.maxMessages) {
      this.messages = this.messages.slice(-this.maxMessages);
    }

    logger.debug(`Received syslog from ${rinfo.address}: ${parsedMessage.message.substring(0, 100)}`);
  }

  parseSyslogMessage(message) {
    // RFC 3164 format parsing (traditional syslog)
    const regex = /^<(\d+)>(\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2})\s+(\S+)\s+(\S+):\s*(.*)$/;
    const match = message.match(regex);

    if (match) {
      const priority = parseInt(match[1]);
      const facility = Math.floor(priority / 8);
      const severity = priority % 8;

      return {
        priority,
        facility,
        severity,
        facilityName: this.getFacilityName(facility),
        severityName: this.getSeverityName(severity),
        timestamp: match[2],
        hostname: match[3],
        tag: match[4],
        message: match[5]
      };
    }

    // RFC 5424 format parsing (new syslog)
    const rfc5424Regex = /^<(\d+)>(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\[.*?\])?\s+(.*)$/;
    const rfc5424Match = message.match(rfc5424Regex);

    if (rfc5424Match) {
      const priority = parseInt(rfc5424Match[1]);
      const facility = Math.floor(priority / 8);
      const severity = priority % 8;

      return {
        priority,
        facility,
        severity,
        facilityName: this.getFacilityName(facility),
        severityName: this.getSeverityName(severity),
        version: rfc5424Match[2],
        timestamp: rfc5424Match[3],
        hostname: rfc5424Match[4],
        appname: rfc5424Match[5],
        procid: rfc5424Match[6],
        msgid: rfc5424Match[7],
        message: rfc5424Match[8]
      };
    }

    // If parsing fails, return simple format
    return {
      priority: 0,
      facility: 0,
      severity: 0,
      facilityName: 'kernel',
      severityName: 'emerg',
      hostname: 'unknown',
      tag: 'unknown',
      message: message
    };
  }

  getFacilityName(facility) {
    const facilities = [
      'kernel', 'user', 'mail', 'daemon', 'auth', 'syslog', 'lpr', 'news',
      'uucp', 'cron', 'authpriv', 'ftp', 'ntp', 'audit', 'alert', 'clock',
      'local0', 'local1', 'local2', 'local3', 'local4', 'local5', 'local6', 'local7'
    ];
    return facilities[facility] || `facility${facility}`;
  }

  getSeverityName(severity) {
    const severities = [
      'emerg', 'alert', 'crit', 'err', 'warning', 'notice', 'info', 'debug'
    ];
    return severities[severity] || `severity${severity}`;
  }

  getMessages(filter = null, limit = 100) {
    let filtered = this.messages;

    if (filter) {
      filtered = this.messages.filter(msg => {
        if (filter.severity && msg.severity !== filter.severity) return false;
        if (filter.facility && msg.facility !== filter.facility) return false;
        if (filter.source && msg.source !== filter.source) return false;
        if (filter.search && !msg.message.toLowerCase().includes(filter.search.toLowerCase())) return false;
        return true;
      });
    }

    return filtered.slice(-limit);
  }

  getMessagesByRouter(routerHost, limit = 100) {
    return this.messages
      .filter(msg => msg.hostname === routerHost || msg.source === routerHost)
      .slice(-limit);
  }

  searchMessages(searchTerm, limit = 100) {
    const term = searchTerm.toLowerCase();
    return this.messages
      .filter(msg => 
        msg.message.toLowerCase().includes(term) ||
        msg.hostname.toLowerCase().includes(term) ||
        msg.tag.toLowerCase().includes(term)
      )
      .slice(-limit);
  }

  clearMessages() {
    const count = this.messages.length;
    this.messages = [];
    logger.info(`Cleared ${count} syslog messages`);
    return count;
  }

  getStatistics() {
    const stats = {
      totalMessages: this.messages.length,
      bySeverity: {},
      byFacility: {},
      bySource: {}
    };

    for (const msg of this.messages) {
      // Count by severity
      const severity = msg.severityName || 'unknown';
      stats.bySeverity[severity] = (stats.bySeverity[severity] || 0) + 1;

      // Count by facility
      const facility = msg.facilityName || 'unknown';
      stats.byFacility[facility] = (stats.byFacility[facility] || 0) + 1;

      // Count by source
      const source = msg.source || 'unknown';
      stats.bySource[source] = (stats.bySource[source] || 0) + 1;
    }

    return stats;
  }

  stop() {
    if (this.server) {
      if (this.server.close) {
        this.server.close();
      }
      this.server = null;
      logger.info('Syslog listener stopped');
    }
  }
}

module.exports = SyslogListener;