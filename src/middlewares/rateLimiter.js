const rateLimit = require('express-rate-limit');

class LifecycleMemoryStore extends rateLimit.MemoryStore {
  init(options) {
    this.options = options;
    this.windowMs = options.windowMs;
  }

  start() {
    if (this.started) return;
    super.init(this.options);
    this.started = true;
  }

  shutdown() {
    if (!this.started) return;
    super.shutdown();
    this.started = false;
  }
}

const stores = [new LifecycleMemoryStore(), new LifecycleMemoryStore()];

// Rate limiter général
const generalLimiter = rateLimit({
  store: stores[0],
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: process.env.NODE_ENV === 'development' ? 10000 : 500,
  standardHeaders: true,
  legacyHeaders: false,
  // Skip socket.io + requests with a Bearer token (authenticated users are already
  // protected by per-route advancedRateLimiter — no need to double-limit them here)
  skip: (req) => {
    if (req.path.startsWith('/socket.io')) return true;
    const auth = req.headers.authorization;
    return Boolean(auth && auth.startsWith('Bearer '));
  },
  message: { message: 'Trop de requêtes. Réessayez plus tard.' },
});

// Rate limiter strict pour les actions sensibles
const strictLimiter = rateLimit({
  store: stores[1],
  windowMs: 60 * 1000, // 1 minute
  max: 10, // 10 requêtes par minute
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Trop de requêtes sensibles. Réessayez dans une minute.' },
});

module.exports = {
  generalLimiter, strictLimiter,
  initialize: () => stores.forEach(store => store.start()),
  stop: () => stores.forEach(store => store.shutdown()),
};