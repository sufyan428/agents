/**
 * Syslog Collector
 * Collects syslog events including failed logins and security events
 */

const dgram = require('dgram');
const logger = require('../utils/logger');
const config = require('../utils/config');
const prometheus = require('../utils/prometheus');

/** Distinct source addresses tracked before least-recently-seen eviction. */
const MAX_TRACKED_SOURCES = 1000;
/** Longest syslog line accepted; anything larger is truncated, not buffered. */
const MAX_MESSAGE_BYTES = 8 * 1024;

class SyslogCollector {
  constructor() {
    this.server = null;
    this.events = [];
    this.failedLogins = new Map();
    this.stats = {
      totalEvents: 0,
      failedLogins: 0,
      securityEvents: 0,
    };
  }

  /**
   * Initialize Syslog server
   */
  initialize() {
    const syslogConfig = config.getSyslogConfig();

    if (!syslogConfig.enabled) {
      logger.info('Syslog collector disabled in configuration');
      return;
    }

    // Convert 'udp' to 'udp4' for Node.js dgram compatibility
    const protocol = syslogConfig.protocol === 'udp' ? 'udp4' : syslogConfig.protocol || 'udp4';
    this.server = dgram.createSocket(protocol);
    const port = syslogConfig.port || 514;

    this.server.on('message', (msg, rinfo) => {
      this.handleSyslogMessage(msg, rinfo);
    });

    this.server.on('error', (error) => {
      logger.error(`Syslog server error: ${error.message}`);
    });

    this.server.bind(port, () => {
      logger.info(`Syslog collector listening on port ${port}`);
    });
  }

  /**
   * Handle incoming syslog message
   */
  handleSyslogMessage(msg, rinfo) {
    try {
      // RFC 5424 allows large messages; this listener is reachable by anyone
      // who can send UDP to the port, so oversized input is truncated rather
      // than retained in the in-memory event ring.
      const message =
        msg.length > MAX_MESSAGE_BYTES
          ? `${msg.subarray(0, MAX_MESSAGE_BYTES).toString('utf8')}...[truncated]`
          : msg.toString('utf8');
      const event = this.parseSyslogMessage(message, rinfo);

      this.stats.totalEvents++;
      this.events.push(event);

      // Check for failed login attempts
      if (this.isFailedLogin(message)) {
        this.handleFailedLogin(event, message);
      }

      // Check for security events
      if (this.isSecurityEvent(message)) {
        this.stats.securityEvents++;
        logger.warn(`Security event from ${event.source}: ${message}`);
      }

      logger.debug(`Syslog from ${rinfo.address}: ${message}`);

      // Keep only last 1000 events in memory
      if (this.events.length > 1000) {
        this.events.shift();
      }
    } catch (error) {
      logger.error(`Failed to parse syslog message from ${rinfo.address}: ${error.message}`);
    }
  }

  /**
   * Parse syslog message
   */
  parseSyslogMessage(message, rinfo) {
    const now = new Date();

    // Simple syslog parsing
    const priorityMatch = message.match(/^<(\d+)>/);

    return {
      timestamp: now.toISOString(),
      source: rinfo.address,
      port: rinfo.port,
      priority: priorityMatch ? parseInt(priorityMatch[1]) : null,
      facility: null,
      severity: null,
      message: message.replace(/^<\d+>/, '').trim(),
      raw: message,
    };
  }

  /**
   * Check if message indicates failed login
   */
  isFailedLogin(message) {
    const failedLoginPatterns = [
      /failed password/i,
      /authentication failed/i,
      /login failed/i,
      /access denied/i,
      /invalid user/i,
    ];

    return failedLoginPatterns.some((pattern) => pattern.test(message));
  }

  /**
   * Check if message is a security event
   */
  isSecurityEvent(message) {
    const securityPatterns = [
      /security/i,
      /breach/i,
      /attack/i,
      /intrusion/i,
      /malware/i,
      /virus/i,
    ];

    return securityPatterns.some((pattern) => pattern.test(message));
  }

  /**
   * Handle failed login event
   */
  handleFailedLogin(event, message) {
    this.stats.failedLogins++;

    // Track failed logins by source IP, with a hard cap on distinct sources.
    // These addresses come from unauthenticated UDP and can be spoofed, so an
    // unbounded Map here was a remote memory-exhaustion vector: one flood with
    // randomised source addresses grew it without limit. At the cap the
    // least-recently-seen entry is evicted, so the map tracks the active
    // offenders rather than every address ever seen.
    const sourceIP = event.source;
    const currentCount = this.failedLogins.get(sourceIP) || 0;
    if (currentCount === 0 && this.failedLogins.size >= MAX_TRACKED_SOURCES) {
      const oldest = this.failedLogins.keys().next().value;
      this.failedLogins.delete(oldest);
      logger.debug(`Failed-login source table full, evicted ${oldest}`);
    }
    // Re-inserting moves the key to the end, giving Map insertion order
    // least-recently-seen-first semantics for the eviction above.
    this.failedLogins.delete(sourceIP);
    this.failedLogins.set(sourceIP, currentCount + 1);

    // Update Prometheus metrics
    const routerName = this.findRouterByIP(sourceIP) || 'unknown';
    prometheus.incrementFailedLogins(routerName, sourceIP);

    logger.warn(`Failed login attempt from ${sourceIP}: ${message}`);
  }

  /**
   * Find router by IP address
   */
  findRouterByIP(ip) {
    const routers = config.getEnabledRouters();
    const router = routers.find((r) => r.ip === ip);
    return router ? router.name : null;
  }

  /**
   * Get failed login statistics
   */
  getFailedLoginStats() {
    const now = Date.now();
    const oneMinuteAgo = now - 60000;

    // Count failed logins in the last minute
    const recentEvents = this.events.filter((event) => {
      const eventTime = new Date(event.timestamp).getTime();
      return eventTime > oneMinuteAgo && this.isFailedLogin(event.message);
    });

    return {
      total: this.stats.failedLogins,
      lastMinute: recentEvents.length,
      bySource: Object.fromEntries(this.failedLogins),
    };
  }

  /**
   * Get recent events
   */
  getRecentEvents(count = 100) {
    return this.events.slice(-count);
  }

  /**
   * Get statistics
   */
  getStats() {
    return {
      ...this.stats,
      failedLoginStats: this.getFailedLoginStats(),
      eventsInMemory: this.events.length,
    };
  }

  /**
   * Clear old events
   */
  clearOldEvents(maxAgeMinutes = 5) {
    const now = Date.now();
    const maxAge = maxAgeMinutes * 60 * 1000;

    this.events = this.events.filter((event) => {
      const eventTime = new Date(event.timestamp).getTime();
      return now - eventTime <= maxAge;
    });

    // Decay the failed-login table. Previously counts over 100 were halved and
    // nothing was ever removed, so the Map only ever grew. Entries now decay
    // and are dropped once they reach zero.
    for (const [ip, count] of this.failedLogins.entries()) {
      const decayed = Math.floor(count / 2);
      if (decayed <= 0) this.failedLogins.delete(ip);
      else this.failedLogins.set(ip, decayed);
    }

    logger.debug(`Cleared old events, remaining: ${this.events.length}`);
  }

  /**
   * Close Syslog server
   */
  close() {
    if (this.server) {
      this.server.close(() => {
        logger.info('Syslog collector closed');
      });
    }
  }
}

module.exports = new SyslogCollector();
