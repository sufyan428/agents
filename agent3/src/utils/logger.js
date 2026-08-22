/**
 * Logger Utility Module
 *
 * Provides structured logging with daily rotation
 */

const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');
const path = require('path');

class Logger {
  /**
   * Create a Winston logger instance
   * @param {Object} config - Logging configuration
   * @returns {winston.Logger} Configured logger instance
   */
  static create(config) {
    const logDir = path.resolve(config.directory);

    // Create log formats
    const logFormat = winston.format.combine(
      winston.format.timestamp({
        format: 'YYYY-MM-DD HH:mm:ss',
      }),
      winston.format.errors({ stack: true }),
      winston.format.splat(),
      winston.format.json(),
    );

    const consoleFormat = winston.format.combine(
      winston.format.colorize(),
      winston.format.timestamp({
        format: 'YYYY-MM-DD HH:mm:ss',
      }),
      winston.format.printf(({ level, message, timestamp, ...metadata }) => {
        let msg = `${timestamp} [${level}]: ${message}`;
        if (Object.keys(metadata).length > 0) {
          msg += ` ${JSON.stringify(metadata)}`;
        }
        return msg;
      }),
    );

    // Create transports
    const transports = [
      // Console transport
      new winston.transports.Console({
        level: config.level,
        format: consoleFormat,
      }),

      // File transport - general logs
      new DailyRotateFile({
        dirname: logDir,
        filename: 'security-agent-%DATE%.log',
        datePattern: config.date_pattern,
        maxSize: config.max_size,
        maxFiles: config.max_files,
        level: config.level,
        format: logFormat,
      }),

      // File transport - error logs
      new DailyRotateFile({
        dirname: logDir,
        filename: 'security-agent-error-%DATE%.log',
        datePattern: config.date_pattern,
        maxSize: config.max_size,
        maxFiles: config.max_files,
        level: 'error',
        format: logFormat,
      }),

      // File transport - security alerts
      new DailyRotateFile({
        dirname: logDir,
        filename: 'security-alerts-%DATE%.log',
        datePattern: config.date_pattern,
        maxSize: config.max_size,
        maxFiles: config.max_files,
        level: 'info',
        format: logFormat,
      }),
    ];

    return winston.createLogger({
      level: config.level,
      transports: transports,
      exitOnError: false,
    });
  }
}

module.exports = Logger;
