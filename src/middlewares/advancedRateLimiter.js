// middlewares/advancedRateLimiter.js
const { RateLimiterMemory } = require('rate-limiter-flexible');
const rateLimitConfig = require('../config/rateLimitConfig');

// Stockage des limiters par endpoint
const limiters = {};

function getLimiter(endpointKey) {
  if (!limiters[endpointKey]) {
    const conf = rateLimitConfig.endpoints[endpointKey] || rateLimitConfig.endpoints.default;
    limiters[endpointKey] = new RateLimiterMemory({
      points: conf.points,
      duration: conf.duration,
      execEvenly: false,
      keyPrefix: endpointKey,
      inmemoryBlockOnConsumed: conf.burst,
      blockDuration: conf.blockDuration,
    });
  }
  return limiters[endpointKey];
}

function getUserKey(req) {
  if (req.user && req.user.id) return `user:${req.user.id}`;
  // fallback IP
  return `ip:${req.ip}`;
}

function isWhitelisted(req) {
  if (req.user && rateLimitConfig.whitelistRoles.includes(req.user.role)) return true;
  if (req.headers[rateLimitConfig.whitelistHeader]) return true;
  return false;
}

function advancedRateLimiter(endpointKey) {
  return async (req, res, next) => {
    if (isWhitelisted(req)) return next();
    const limiter = getLimiter(endpointKey);
    const key = getUserKey(req);
    try {
      await limiter.consume(key, 1);
      return next();
    } catch (rejRes) {
      const retrySecs = Math.round(rejRes.msBeforeNext / 1000) || 1;
      res.set('Retry-After', retrySecs);
      return res.status(429).json({
        message: 'Trop de requêtes. Réessayez dans ' + retrySecs + 's.',
        retryAfter: retrySecs,
      });
    }
  };
}

module.exports = { advancedRateLimiter };
