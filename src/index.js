require('dotenv').config();
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
const cors = require('cors');

const app = express();
app.set('trust proxy', 1);
const server = http.createServer(app);

// Socket
notificationService.initialize(server);

// ----------------------
// CORS
// ----------------------
const envOrigins = String(process.env.FRONTEND_URL || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const allowedOrigins = [
  'https://teamoff-app.vercel.app',
  'http://localhost:3001',
  'http://localhost:5173',
  ...envOrigins,
];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true); 
    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'), false);
    }
  },
  credentials: true, // important si tu envoies cookies ou JWT
}));

// Autoriser les requêtes preflight OPTIONS
app.use((req, res, next) => {
  if (req.method === 'OPTIONS') {
    res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
    res.header('Access-Control-Allow-Methods', 'GET,PUT,POST,DELETE,OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
    res.header('Access-Control-Allow-Credentials', 'true');
    return res.sendStatus(200);
  }
  next();
});

// ----------------------
// Middlewares
// ----------------------
app.use(require('cookie-parser')());
app.use(express.json());
app.use(compression());
app.use(metricsMiddleware);

app.use((req, res, next) => {
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(generalLimiter);

// ----------------------
// Health check
// ----------------------
app.get('/health', async (req, res) => {
  try {
    await sequelize.authenticate();
    res.json({ status: 'ok' });
  } catch (error) {
    res.status(503).json({ status: 'error' });
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
const startServer = async () => {
  try {
    await sequelize.authenticate();
    logger.info('✅ DB connected');

    // 🔥 SYNCHRONISATION DES MODELS
      await sequelize.sync({ alter: false }); // alter: true crée/modifie les tables sans perte de données

    logger.info('✅ Models synchronisés avec la DB');

    // Cron jobs
    await initBackupCron();
    initQuotasCron();

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