// middlewares/advancedRateLimiter.js
const { RateLimiterMemory, RateLimiterRedis } = require('rate-limiter-flexible');
const rateLimitConfig = require('../config/rateLimitConfig');
const logger = require('../utils/logger');

// ---------------------------------------------------------------------------
// Redis client (optional) — falls back to memory if REDIS_URL is absent or
// ioredis is not installed, and automatically via insuranceLimiter on errors.
// ---------------------------------------------------------------------------
let redisClient = null;
if (process.env.REDIS_URL) {
  try {
    const Redis = require('ioredis');
    redisClient = new Redis(process.env.REDIS_URL, {
      enableOfflineQueue: false, // fail fast so insuranceLimiter kicks in
      maxRetriesPerRequest: 0,
    });
    redisClient.on('ready', () => logger.info('Rate limiter: Redis connected'));
    redisClient.on('error', (err) => logger.warn('Rate limiter: Redis error', { error: err.message }));
  } catch {
    logger.warn('Rate limiter: ioredis not installed — using in-memory fallback (npm install ioredis to enable Redis)');
  }
}

// Stockage des limiters par endpoint
const limiters = {};

function buildLimiter(endpointKey) {
  const conf = rateLimitConfig.endpoints[endpointKey] || rateLimitConfig.endpoints.default;
  const opts = {
    points: conf.points,
    duration: conf.duration,
    keyPrefix: endpointKey,
    blockDuration: conf.blockDuration,
  };

  const memoryLimiter = new RateLimiterMemory({ ...opts, inmemoryBlockOnConsumed: conf.burst });

  if (redisClient) {
    // insuranceLimiter = automatic in-memory fallback if Redis is temporarily unavailable
    return new RateLimiterRedis({ ...opts, storeClient: redisClient, insuranceLimiter: memoryLimiter });
  }

  return memoryLimiter;
}

function getLimiter(endpointKey) {
  if (!limiters[endpointKey]) {
    limiters[endpointKey] = buildLimiter(endpointKey);
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
