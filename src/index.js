if (process.env.TEAMOFF_INTEGRATION_HARNESS) {
  require('../config/integrationHarness').assertHarnessImport('app');
} else require('dotenv').config();
// Node.js 18+ préfère IPv6 par défaut — force IPv4 pour les envs sans IPv6 (ex: Render Free)
require('dns').setDefaultResultOrder('ipv4first');
const express = require('express');
const logger = require('./utils/logger');
const compression = require('compression');
const http = require('http');
// Import de l'instance sequelize et des modèles
const models = require('./models');
const sequelize = models.sequelize;
const cors = require('cors');
const helmet = require('helmet');
const sanitizeInput = require('./middlewares/sanitizeInput');
const requestId = require('./middlewares/requestId');
const requestLogger = require('./middlewares/requestLogger');
const { verifyStartupSchema } = require('./services/startupSchemaService');
const { createBackendLifecycle, listenHttp, closeHttp } = require('./services/backendLifecycle');

const app = express();
app.set('trust proxy', 1);
let server;

let configured = false;
let queryDatabase;
function getQueryDatabase() {
  if (!queryDatabase) {
    queryDatabase = require('./config/database');
    if (queryDatabase !== sequelize) lifecycle.register('PostgreSQL requêtes', () => queryDatabase.close());
  }
  return queryDatabase;
}

function configureApplication() {
  if (configured) return;
  getQueryDatabase();
  const routes = require('./routes');
  const { metricsMiddleware } = require('./middlewares/metrics');
  const { generalLimiter } = require('./middlewares/rateLimiter');
  const errorHandler = require('./middlewares/errorHandler');
  const maintenanceMode = require('./middlewares/maintenanceMode');

  // ----------------------
  // CORS
  // ----------------------
  // Seules les origines HTTPS ou http://localhost sont acceptées depuis FRONTEND_URL
  const envOrigins = String(process.env.FRONTEND_URL || '')
    .split(',')
    .map((o) => o.trim())
    .filter((o) => {
      try {
        const u = new URL(o);
        return u.protocol === 'https:' || (u.protocol === 'http:' && u.hostname === 'localhost');
      } catch { return false; }
    });

  // Toutes les origines CORS passent par FRONTEND_URL (virgule-séparées)
  const allowedOrigins = envOrigins;

  function isSameOrigin(a, b) {
    try {
      const ua = new URL(a);
      const ub = new URL(b);
      return ua.protocol === ub.protocol && ua.hostname === ub.hostname && ua.port === ub.port;
    } catch { return false; }
  }

  // Security headers — CSP off (pure API), CORP relaxed pour SSE EventSource
  app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    hsts: { maxAge: 31536000, includeSubDomains: true }, // HTTPS only, 1 an
    frameguard: { action: 'deny' },                      // X-Frame-Options: DENY
    noSniff: true,                                        // X-Content-Type-Options: nosniff
  }));

  app.use(cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (allowedOrigins.some((allowed) => isSameOrigin(origin, allowed))) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'), false);
      }
    },
    credentials: true,
    exposedHeaders: ['X-TeamOff-Warning'],
  }));

  // ----------------------
  // Middlewares
  // ----------------------
  app.use(requestId);                            // UUID par requête — doit être en premier
  app.use(require('cookie-parser')());
  app.use(express.json({ limit: '100kb' }));

  // Rejette les requêtes POST/PUT/PATCH sans Content-Type application/json
  // (exclut multipart/form-data pour les uploads de fichiers)
  app.use((req, res, next) => {
    if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
      const ct = req.headers['content-type'] || '';
      if (ct.includes('multipart/form-data') || ct.includes('application/x-www-form-urlencoded')) {
        return next(); // uploads et formulaires — gérés par leurs propres middlewares
      }
      if (req.headers['content-length'] === '0' || !req.headers['content-length']) {
        return next(); // body vide autorisé (ex: POST /logout)
      }
      if (!ct.includes('application/json')) {
        return res.status(415).json({ message: 'Content-Type application/json requis' });
      }
    }
    next();
  });

  app.use(compression());
  app.use(sanitizeInput);
  app.use(requestLogger);
  app.use(metricsMiddleware);

  app.use(generalLimiter);

  // Timeout adaptatif : 60s pour les routes admin/settings (cold start Render), 30s sinon
  app.use((req, res, next) => {
    if (req.path.includes('/stream')) return next();
    const isAdminRoute = req.path.startsWith('/api/settings') || req.path.startsWith('/api/superadmin');
    const timeoutMs = isAdminRoute ? 60_000 : 30_000;
    const ac = new AbortController();
    req.signal = ac.signal;
    const timer = setTimeout(() => {
      ac.abort();
      req.timedOut = true;
      if (!res.headersSent) {
        res.setHeader('Retry-After', '30');
        res.status(503).json({ message: 'Délai de traitement dépassé' });
      }
    }, timeoutMs);
    res.on('finish', () => clearTimeout(timer));
    res.on('close', () => clearTimeout(timer));
    next();
  });

  // ----------------------
  // Health check
  // ----------------------
  app.get('/health', (req, res) => {
    res.json({
      status:    'ok',
      uptime:    Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
    });
  });

  // ----------------------
  // Routes
  // ----------------------
  app.use(maintenanceMode);
  app.use('/api', routes);

  // ----------------------
  // Error handler
  // ----------------------
  app.use(errorHandler);
  configured = true;
}

// ----------------------
// START SERVER
// ----------------------
const REQUIRED_ENV = ['JWT_SECRET', 'JWT_REFRESH_SECRET', 'DATABASE_URL', 'MAIL_HOST', 'MAIL_USER', 'MAIL_PASS', 'MAIL_SECURE', 'EMAIL_FROM', 'FRONTEND_URL'];

function validateEnvironment() {
  // Vérification des variables d'environnement critiques
  const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    throw new Error(`Variables d'environnement manquantes : ${missing.join(', ')}`);
  }
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
    throw new Error('JWT_SECRET trop court (minimum 32 caractères)');
  }
}

const lifecycle = createBackendLifecycle({
  logger,
  async validate() {
    validateEnvironment();
    await sequelize.authenticate();
    logger.info('✅ DB connected');
    await verifyStartupSchema(sequelize);
  },
  async initialize(register, assertStarting) {
    // Register the second historical pool before routes import it.
    getQueryDatabase();
    const rateLimiter = require('./middlewares/rateLimiter');
    const advancedLimiter = require('./middlewares/advancedRateLimiter');
    register('Limiteurs mémoire', rateLimiter.stop);
    register('Redis', advancedLimiter.stop);
    configureApplication();
    rateLimiter.initialize();
    advancedLimiter.initialize();

    server = http.createServer(app);
    let httpDrain;
    let httpError;
    register('HTTP', async () => {
      if (httpDrain) await httpDrain;
      if (httpError) throw httpError;
    });
    const sockets = require('./services/notificationSocketService');
    const sse = require('./services/sseManager');
    register('Socket.IO', () => sockets.close());
    register('SSE', sse.stop);
    const backup = require('./cron/backupCron');
    const quotas = require('./cron/quotasCron');
    const emails = require('./cron/emailCron');
    register('Crons', async () => {
      const results = await Promise.allSettled([
        backup.stopBackupCron, quotas.stopQuotasCron, emails.stopEmailCron,
      ].map(stop => Promise.resolve().then(stop)));
      const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
      if (errors.length) throw new AggregateError(errors, 'Arrêt des crons incomplet.');
    });
    register('Arrêt des nouvelles connexions HTTP', () => {
      httpDrain = closeHttp(server).catch(error => { httpError = error; });
    });

    sockets.initialize(server);
    sse.initialize();
    // Keep the historical isolation between cron groups.
    for (const [name, init] of [
      ['initBackupCron', backup.initBackupCron],
      ['initQuotasCron', quotas.initQuotasCron],
      ['initEmailCron', emails.initEmailCron],
    ]) {
      assertStarting();
      try { await init(); } catch (error) {
        logger.error(`${name} failed`, { error: require('./utils/sanitizeLogData').sanitizeMessage(error.message) });
      }
    }
  },
  async listen() {
    const port = process.env.PORT || 5500;
    await listenHttp(server, port);
    logger.info(`🚀 Server running on port ${port}`);
  },
});
lifecycle.register('PostgreSQL modèles', () => sequelize.close());

const startServer = () => process.env.TEAMOFF_INTEGRATION_HARNESS
  ? Promise.reject(new Error('Démarrage du backend interdit dans le harness isolé.'))
  : lifecycle.start();
const stopServer = () => lifecycle.stop();

function reportFailure(label, error) {
  const { sanitizeError } = require('./utils/sanitizeLogData');
  logger.error(label, sanitizeError(error));
  process.exitCode = 1;
}

if (require.main === module) {
  let shutdownPromise;
  const shutdown = () => {
    if (!shutdownPromise) shutdownPromise = stopServer().catch(error => reportFailure('❌ Shutdown error:', error));
    return shutdownPromise;
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  startServer().then(() => {
    server.on('error', error => {
      reportFailure('❌ HTTP error:', error);
      shutdown();
    });
  }).catch(error => reportFailure('❌ Startup error:', error));
} else {
  // Preserve the Express export used by integration tests without starting resources.
  configureApplication();
}

module.exports = app;
module.exports.startServer = startServer;
module.exports.stopServer = stopServer;