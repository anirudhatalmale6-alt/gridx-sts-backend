const { createLogger, format, transports } = require('winston');
const path = require('path');

const logsDir = path.join(__dirname, '..', 'logs');

const logger = createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: format.combine(
    format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    format.errors({ stack: true }),
    format.splat(),
    format.json()
  ),
  defaultMeta: { service: 'gridx-sts-backend' },
  transports: [
    // Error-only file transport
    new transports.File({
      filename: path.join(logsDir, 'error.log'),
      level: 'error',
      maxsize: 5 * 1024 * 1024, // 5 MB
      maxFiles: 5,
    }),

    // Combined (all levels) file transport
    new transports.File({
      filename: path.join(logsDir, 'combined.log'),
      maxsize: 10 * 1024 * 1024, // 10 MB
      maxFiles: 5,
    }),
  ],
});

// Console transport with colorized output
logger.add(
  new transports.Console({
    format: format.combine(
      format.colorize(),
      format.timestamp({ format: 'HH:mm:ss' }),
      format.printf(({ timestamp, level, message, stack }) => {
        return stack
          ? `${timestamp} ${level}: ${message}\n${stack}`
          : `${timestamp} ${level}: ${message}`;
      })
    ),
  })
);

module.exports = logger;
