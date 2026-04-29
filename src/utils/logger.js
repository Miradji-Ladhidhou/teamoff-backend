const { createLogger, format, transports } = require('winston');

const { combine, timestamp, errors, json, colorize, simple } = format;

const isProduction = process.env.NODE_ENV === 'production';

// Injecte automatiquement le requestId depuis AsyncLocalStorage dans chaque log.
// Si le champ est déjà présent (posé explicitement par l'appelant), il est conservé.
const injectRequestId = format((info) => {
  if (!info.requestId) {
    try {
      // Import différé pour éviter la dépendance circulaire au démarrage
      const { getRequestId } = require('./requestContext');
      info.requestId = getRequestId();
    } catch {
      info.requestId = 'unknown';
    }
  }
  return info;
});

const logger = createLogger({
  level: process.env.LOG_LEVEL || (isProduction ? 'info' : 'debug'),
  format: combine(
    injectRequestId(),
    timestamp({ format: 'YYYY-MM-DDTHH:mm:ssZ' }),
    errors({ stack: true }),
    json()
  ),
  transports: [
    new transports.Console({
      format: isProduction
        ? combine(injectRequestId(), timestamp(), errors({ stack: true }), json())
        : combine(colorize(), simple()),
    }),
  ],
});

module.exports = logger;
