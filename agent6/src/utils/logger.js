const winston = require('winston');
const path = require('path');

// Create logs directory if it doesn't exist
const fs = require('fs');
const logsDir = path.join(__dirname, '..', '..', 'logs');
if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
}

// Configure logger
const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        winston.format.errors({ stack: true }),
        winston.format.splat(),
        winston.format.json()
    ),
    defaultMeta: { service: 'orchestrator' },
    transports: [
        // Write all logs to console
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                winston.format.printf(({ timestamp, level, message, service }) => {
                    return `${timestamp} [${service}] ${level}: ${message}`;
                })
            )
        }),
        // Write all logs to file
        new winston.transports.File({
            filename: path.join(logsDir, 'orchestrator.log'),
            maxsize: 10485760, // 10MB
            maxFiles: 5
        }),
        // Write error logs to separate file
        new winston.transports.File({
            filename: path.join(logsDir, 'orchestrator-error.log'),
            level: 'error',
            maxsize: 10485760,
            maxFiles: 5
        })
    ]
});

module.exports = logger;
