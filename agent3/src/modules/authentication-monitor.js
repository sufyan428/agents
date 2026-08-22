/**
 * Authentication Monitoring Module
 * 
 * Monitors authentication events to detect:
 * - Failed login attempts
 * - Brute force attacks
 * - Account lockouts
 * - Suspicious authentication patterns
 */

class AuthenticationMonitor {
  constructor(config, logger, metrics, alertDispatcher) {
    this.config = config;
    this.logger = logger;
    this.metrics = metrics;
    this.alertDispatcher = alertDispatcher;

    // Track failed login attempts by IP and username
    this.failedAttempts = new Map(); // Key: "source_ip:username", Value: { count, timestamps: [] }
    this.lockedAccounts = new Set(); // Set of locked usernames
    this.suspiciousIps = new Set(); // Set of suspicious IP addresses

    // Cleanup interval for old failed attempt records
    this.cleanupInterval = setInterval(() => {
      this.cleanupOldRecords();
    }, 60000); // Cleanup every minute
  }

  /**
   * Process a syslog message for authentication events
   * @param {Object} syslogData - Parsed syslog message
   */
  processSyslogMessage(syslogData) {
    try {
      const message = syslogData.message.toLowerCase();
      const sourceIp = this.extractIpAddress(syslogData.message) || 'unknown';
      const username = this.extractUsername(syslogData.message) || 'unknown';

      // Detect failed login attempts
      if (this.isFailedLogin(message)) {
        this.handleFailedLogin(sourceIp, username, syslogData);
      }

      // Detect successful login attempts
      else if (this.isSuccessfulLogin(message)) {
        this.handleSuccessfulLogin(sourceIp, username, syslogData);
      }

      // Detect account lockouts
      else if (this.isAccountLockout(message)) {
        this.handleAccountLockout(username, syslogData);
      }

      // Detect unauthorized access attempts
      else if (this.isUnauthorizedAccess(message)) {
        this.handleUnauthorizedAccess(sourceIp, username, syslogData);
      }

      // Detect privilege escalation attempts
      else if (this.isPrivilegeEscalation(message)) {
        this.handlePrivilegeEscalation(sourceIp, username, syslogData);
      }

    } catch (error) {
      this.logger.error('Error processing authentication syslog message:', error);
    }
  }

  /**
   * Handle failed login attempt
   */
  handleFailedLogin(sourceIp, username, syslogData) {
    const key = `${sourceIp}:${username}`;
    const now = Date.now();

    // Initialize or get existing failed attempt record
    let attemptRecord = this.failedAttempts.get(key);
    if (!attemptRecord) {
      attemptRecord = { count: 0, timestamps: [] };
      this.failedAttempts.set(key, attemptRecord);
    }

    // Add failed attempt
    attemptRecord.count++;
    attemptRecord.timestamps.push(now);

    // Remove timestamps outside the time window
    const timeWindowMs = this.config.time_window_seconds * 1000;
    attemptRecord.timestamps = attemptRecord.timestamps.filter(
      timestamp => now - timestamp <= timeWindowMs
    );
    attemptRecord.count = attemptRecord.timestamps.length;

    // Update metrics
    this.metrics.incrementFailedLogin(sourceIp, username);

    this.logger.warn('Failed login attempt detected', {
      source_ip: sourceIp,
      username: username,
      attempt_count: attemptRecord.count,
      timestamp: new Date().toISOString()
    });

    // Check if threshold exceeded
    if (attemptRecord.count >= this.config.max_failed_attempts) {
      this.handleBruteForceAttack(sourceIp, username, attemptRecord.count);
    }

    // Check if lockout threshold exceeded
    if (attemptRecord.count >= this.config.lockout_threshold) {
      this.handleAccountLockout(username, {
        ...syslogData,
        reason: 'exceeded_max_attempts'
      });
    }
  }

  /**
   * Handle successful login attempt
   */
  handleSuccessfulLogin(sourceIp, username, _syslogData) {
    // Check if IP was previously suspicious
    if (this.suspiciousIps.has(sourceIp)) {
      this.logger.warn('Successful login from previously suspicious IP', {
        source_ip: sourceIp,
        username: username,
        warning: 'IP was flagged for suspicious activity'
      });

      this.alertDispatcher.dispatchAlert({
        type: 'suspicious_login',
        severity: 'medium',
        title: 'Successful Login from Suspicious IP',
        description: `User ${username} successfully logged in from IP ${sourceIp}, which was previously flagged for suspicious activity`,
        details: {
          source_ip: sourceIp,
          username: username,
          previous_suspicious_activity: true,
          timestamp: new Date().toISOString()
        }
      });
    }

    // Reset failed attempts for this combination
    const key = `${sourceIp}:${username}`;
    this.failedAttempts.delete(key);

    // Update metrics
    this.metrics.incrementSuccessfulLogin(sourceIp, username);

    this.logger.info('Successful login attempt', {
      source_ip: sourceIp,
      username: username,
      timestamp: new Date().toISOString()
    });
  }

  /**
   * Handle brute force attack detection
   */
  handleBruteForceAttack(sourceIp, username, attemptCount) {
    const severity = attemptCount >= this.config.lockout_threshold ? 'critical' : 'high';

    this.logger.error('Brute force attack detected', {
      source_ip: sourceIp,
      username: username,
      attempt_count: attemptCount,
      severity: severity,
      timestamp: new Date().toISOString()
    });

    // Add to suspicious IPs
    this.suspiciousIps.add(sourceIp);

    // Record threat
    this.metrics.recordThreat('brute_force_attack', severity);

    // Dispatch alert
    this.alertDispatcher.dispatchAlert({
      type: 'brute_force_attack',
      severity: severity,
      title: 'Brute Force Attack Detected',
      description: `Detected ${attemptCount} failed login attempts for user ${username} from IP ${sourceIp}`,
      details: {
        source_ip: sourceIp,
        username: username,
        attempt_count: attemptCount,
        time_window_seconds: this.config.time_window_seconds,
        threshold: this.config.max_failed_attempts,
        recommended_action: severity === 'critical' 
          ? 'Immediately block IP address and notify security team'
          : 'Monitor closely and consider temporary IP block',
        timestamp: new Date().toISOString()
      }
    });
  }

  /**
   * Handle account lockout
   */
  handleAccountLockout(username, syslogData = {}) {
    const reason = syslogData.reason || 'exceeded_max_attempts';

    this.logger.error('Account lockout detected', {
      username: username,
      reason: reason,
      timestamp: new Date().toISOString()
    });

    // Add to locked accounts set
    this.lockedAccounts.add(username);

    // Update metrics
    this.metrics.recordAccountLockout(username, reason);
    this.metrics.recordThreat('account_lockout', 'high');

    // Dispatch alert
    this.alertDispatcher.dispatchAlert({
      type: 'account_lockout',
      severity: 'high',
      title: 'Account Lockout Detected',
      description: `Account ${username} has been locked due to ${reason}`,
      details: {
        username: username,
        reason: reason,
        recommended_action: 'Verify if lockout was legitimate. If not, investigate potential breach.',
        timestamp: new Date().toISOString()
      }
    });
  }

  /**
   * Handle unauthorized access attempt
   */
  handleUnauthorizedAccess(sourceIp, username, syslogData) {
    this.logger.error('Unauthorized access attempt detected', {
      source_ip: sourceIp,
      username: username,
      message: syslogData.message,
      timestamp: new Date().toISOString()
    });

    // Record threat
    this.metrics.recordThreat('unauthorized_access', 'critical');

    // Add IP to suspicious list
    this.suspiciousIps.add(sourceIp);

    // Dispatch alert
    this.alertDispatcher.dispatchAlert({
      type: 'unauthorized_access',
      severity: 'critical',
      title: 'Unauthorized Access Attempt',
      description: `Unauthorized access attempt detected from IP ${sourceIp}`,
      details: {
        source_ip: sourceIp,
        username: username,
        message: syslogData.message,
        recommended_action: 'Immediate investigation required. Consider blocking IP.',
        timestamp: new Date().toISOString()
      }
    });
  }

  /**
   * Handle privilege escalation attempt
   */
  handlePrivilegeEscalation(sourceIp, username, syslogData) {
    this.logger.error('Privilege escalation attempt detected', {
      source_ip: sourceIp,
      username: username,
      message: syslogData.message,
      timestamp: new Date().toISOString()
    });

    // Record threat
    this.metrics.recordThreat('privilege_escalation', 'critical');

    // Dispatch alert
    this.alertDispatcher.dispatchAlert({
      type: 'privilege_escalation',
      severity: 'critical',
      title: 'Privilege Escalation Attempt',
      description: `Privilege escalation attempt detected for user ${username} from IP ${sourceIp}`,
      details: {
        source_ip: sourceIp,
        username: username,
        message: syslogData.message,
        recommended_action: 'Critical: Immediate security investigation required',
        timestamp: new Date().toISOString()
      }
    });
  }

  /**
   * Check if message indicates failed login
   */
  isFailedLogin(message) {
    const failedPatterns = [
      /failed\s+password/i,
      /failed\s+login/i,
      /authentication\s+failed/i,
      /login\s+failed/i,
      /invalid\s+password/i,
      /incorrect\s+password/i,
      /access\s+denied/i,
      /authentication\s+failure/i
    ];

    return failedPatterns.some(pattern => pattern.test(message));
  }

  /**
   * Check if message indicates successful login
   */
  isSuccessfulLogin(message) {
    const successPatterns = [
      /accepted\s+password/i,
      /login\s+successful/i,
      /authentication\s+successful/i,
      /session\s+opened/i,
      /user\s+logged\s+in/i
    ];

    return successPatterns.some(pattern => pattern.test(message));
  }

  /**
   * Check if message indicates account lockout
   */
  isAccountLockout(message) {
    const lockoutPatterns = [
      /account\s+locked/i,
      /account\s+disabled/i,
      /user\s+locked/i,
      /too\s+many\s+failed\s+attempts/i,
      /lockout\s+triggered/i
    ];

    return lockoutPatterns.some(pattern => pattern.test(message));
  }

  /**
   * Check if message indicates unauthorized access
   */
  isUnauthorizedAccess(message) {
    const unauthorizedPatterns = [
      /unauthorized\s+access/i,
      /access\s+violated/i,
      /permission\s+denied/i,
      /security\s+violation/i,
      /invalid\s+user/i,
      /unknown\s+user/i
    ];

    return unauthorizedPatterns.some(pattern => pattern.test(message));
  }

  /**
   * Check if message indicates privilege escalation
   */
  isPrivilegeEscalation(message) {
    const escalationPatterns = [
      /privilege\s+escalation/i,
      /sudo\s+attempt/i,
      /su\s+attempt/i,
      /root\s+access/i,
      /administrative\s+access/i,
      /elevated\s+privileges/i
    ];

    return escalationPatterns.some(pattern => pattern.test(message));
  }

  /**
   * Extract IP address from message
   */
  extractIpAddress(message) {
    const ipPattern = /\b(?:\d{1,3}\.){3}\d{1,3}\b/;
    const match = message.match(ipPattern);
    return match ? match[0] : null;
  }

  /**
   * Extract username from message
   */
  extractUsername(message) {
    // Try various patterns for username extraction
    const patterns = [
      /user\s+(\S+)/i,
      /username\s*[:=]\s*(\S+)/i,
      /for\s+user\s+(\S+)/i,
      /invalid\s+user\s+(\S+)/i,
      /from\s+(\S+)\s+port/i
    ];

    for (const pattern of patterns) {
      const match = message.match(pattern);
      if (match) {
        return match[1];
      }
    }

    return null;
  }

  /**
   * Cleanup old failed attempt records
   */
  cleanupOldRecords() {
    const now = Date.now();
    const timeWindowMs = this.config.time_window_seconds * 1000;

    for (const [key, attemptRecord] of this.failedAttempts.entries()) {
      // Remove timestamps outside the time window
      attemptRecord.timestamps = attemptRecord.timestamps.filter(
        timestamp => now - timestamp <= timeWindowMs
      );

      // Remove record if no recent attempts
      if (attemptRecord.timestamps.length === 0) {
        this.failedAttempts.delete(key);
      } else {
        attemptRecord.count = attemptRecord.timestamps.length;
      }
    }

    this.logger.debug('Cleaned up old authentication records', {
      remaining_records: this.failedAttempts.size
    });
  }

  /**
   * Get current statistics
   */
  getStatistics() {
    return {
      failed_attempts_by_user: Array.from(this.failedAttempts.entries()).map(([key, record]) => {
        const [sourceIp, username] = key.split(':');
        return {
          source_ip: sourceIp,
          username: username,
          count: record.count,
          timestamps: record.timestamps
        };
      }),
      locked_accounts: Array.from(this.lockedAccounts),
      suspicious_ips: Array.from(this.suspiciousIps),
      total_failed_attempts: this.failedAttempts.size
    };
  }

  /**
   * Reset monitoring state (useful for testing)
   */
  reset() {
    this.failedAttempts.clear();
    this.lockedAccounts.clear();
    this.suspiciousIps.clear();
    this.logger.info('Authentication monitor state reset');
  }

  /**
   * Cleanup resources
   */
  destroy() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
  }
}

module.exports = AuthenticationMonitor;