const rateLimit = require('express-rate-limit');

// Rate limiter général
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: process.env.NODE_ENV === 'development' ? 10000 : 100, // allow more in dev
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path.startsWith('/socket.io'), // avoid blocking socket handshake
  message: { message: 'Trop de requêtes. Réessayez plus tard.' },
});

// Rate limiter strict pour les actions sensibles
const strictLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10, // 10 requêtes par minute
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Trop de requêtes sensibles. Réessayez dans une minute.' },
});

module.exports = { generalLimiter, strictLimiter };