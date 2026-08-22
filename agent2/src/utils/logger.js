const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');
const path = require('path');

class Logger {
  constructor(config) {
    this.config = config;
    this.logger = this.createLogger();
  }

  createLogger() {
    const logDir = this.config.logging?.directory || '/app/logs';
    const logLevel = this.config.logging?.level || 'info';
    const maxSize = this.config.logging?.max_size || '20m';
    const maxFiles = this.config.logging?.max_files || '14d';
    const datePattern = this.config.logging?.date_pattern || 'YYYY-MM-DD';

    const transports = [
      // Console transport
      new winston.transports.Console({
        format: winston.format.combine(
          winston.format.colorize(),
          winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
          winston.format.printf(({ timestamp, level, message, ...metadata }) => {
            let msg = `${timestamp} [${level}]: ${message}`;
            if (Object.keys(metadata).length > 0) {
              msg += ` ${JSON.stringify(metadata)}`;
            }
            return msg;
          })
        )
      }),

      // File transport with rotation
      new DailyRotateFile({
        dirname: logDir,
        filename: 'resilience-agent-%DATE%.log',
        datePattern: datePattern,
        maxSize: maxSize,
        maxFiles: maxFiles,
        format: winston.format.combine(
          winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
          winston.format.json()
        )
      }),

      // Error log file
      new DailyRotateFile({
        dirname: logDir,
        filename: 'resilience-agent-error-%DATE%.log',
        datePattern: datePattern,
        level: 'error',
        maxSize: maxSize,
        maxFiles: maxFiles,
        format: winston.format.combine(
          winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
          winston.format.json()
        )
      })
    ];

    return winston.createLogger({
      level: logLevel,
      transports: transports,
      exitOnError: false
    });
  }

  info(message, metadata = {}) {
    this.logger.info(message, metadata);
  }

  error(message, metadata = {}) {
    this.logger.error(message, metadata);
  }

  warn(message, metadata = {}) {
    this.logger.warn(message, metadata);
  }

  debug(message, metadata = {}) {
    this.logger.debug(message, metadata);
  }

  critical(message, metadata = {}) {
    this.logger.error(`[CRITICAL] ${message}`, metadata);
  }

  logFailover(event) {
    this.critical('FAILOVER EVENT', {
      event_type: event.type,
      timestamp: new Date().toISOString(),
      primary_router: event.primary,
      backup_router: event.backup,
      reason: event.reason,
      action: event.action,
      duration: event.duration
    });
  }

  logHealthCheck(check) {
    this.debug('HEALTH CHECK', {
      router: check.router,
      status: check.status,
      response_time: check.response_time,
      method: check.method
    });
  }

  logConfigSync(sync) {
    this.info('CONFIG SYNC', {
      type: sync.type,
      status: sync.status,
      source: sync.source,
      destination: sync.destination,
      timestamp: new Date().toISOString()
    });
  }
}

module.exports = Logger;