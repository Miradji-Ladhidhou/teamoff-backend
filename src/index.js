require('dotenv').config();
// Node.js 18+ préfère IPv6 par défaut — force IPv4 pour les envs sans IPv6 (ex: Render Free)
require('dns').setDefaultResultOrder('ipv4first');
const express = require('express');
const logger = require('./utils/logger');
const compression = require('compression');
const http = require('http');
// Import de l'instance sequelize et des modèles
const models = require('./models');
const sequelize = models.sequelize;
const routes = require('./routes');
const { metricsMiddleware } = require('./middlewares/metrics');
const { generalLimiter } = require('./middlewares/rateLimiter');
const errorHandler = require('./middlewares/errorHandler');
const notificationService = require('./services/notificationSocketService');
const maintenanceMode = require('./middlewares/maintenanceMode');
const { initBackupCron } = require('./cron/backupCron');
const { initQuotasCron } = require('./cron/quotasCron');
const { initEmailCron } = require('./cron/emailCron');
const cors = require('cors');
const helmet = require('helmet');
const sanitizeInput = require('./middlewares/sanitizeInput');
const requestId = require('./middlewares/requestId');
const requestLogger = require('./middlewares/requestLogger');

const app = express();
app.set('trust proxy', 1);
const server = http.createServer(app);

// Socket
notificationService.initialize(server);

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
app.get('/health', async (req, res) => {
  try {
    await sequelize.authenticate();
    res.json({
      status:    'ok',
      db:        'up',
      uptime:    Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
    });
  } catch {
    res.status(503).json({
      status:    'error',
      db:        'down',
      uptime:    Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
    });
  }
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

// ----------------------
// START SERVER
// ----------------------
const REQUIRED_ENV = ['JWT_SECRET', 'JWT_REFRESH_SECRET', 'DATABASE_URL', 'MAIL_HOST', 'MAIL_USER', 'MAIL_PASS', 'MAIL_SECURE', 'EMAIL_FROM', 'FRONTEND_URL'];

const startServer = async () => {
  // Vérification des variables d'environnement critiques
  const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    logger.error(`❌ Variables d'environnement manquantes : ${missing.join(', ')}`);
    process.exit(1);
  }
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
    logger.error('❌ JWT_SECRET trop court (minimum 32 caractères)');
    process.exit(1);
  }

  try {
    await sequelize.authenticate();
    logger.info('✅ DB connected');

    // Cron jobs — isolated so one failure doesn't block startup
    try { await initBackupCron(); } catch (e) { logger.error('initBackupCron failed', { error: e.message }); }
    try { initQuotasCron(); } catch (e) { logger.error('initQuotasCron failed', { error: e.message }); }
    try { initEmailCron(); } catch (e) { logger.error('initEmailCron failed', { error: e.message }); }

    const PORT = process.env.PORT || 5500;

    server.listen(PORT, () => {
      logger.info(`🚀 Server running on port ${PORT}`);
    });

  } catch (err) {
    logger.error('❌ Startup error:', err);
    process.exit(1);
  }
};

if (require.main === module) {
  startServer();
}

module.exports = app;