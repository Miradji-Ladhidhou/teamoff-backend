const { createLogger, format, transports } = require('winston');

const { combine, timestamp, errors, json, colorize, simple } = format;

const isProduction = process.env.NODE_ENV === 'production';

const logger = createLogger({
  level: process.env.LOG_LEVEL || (isProduction ? 'info' : 'debug'),
  format: combine(
    timestamp({ format: 'YYYY-MM-DDTHH:mm:ssZ' }),
    errors({ stack: true }),
    json()
  ),
  transports: [
    new transports.Console({
      format: isProduction
        ? combine(timestamp(), errors({ stack: true }), json())
        : combine(colorize(), simple()),
    }),
  ],
});

module.exports = logger;
