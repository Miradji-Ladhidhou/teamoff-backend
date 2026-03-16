const express = require('express');
const compression = require('compression');
const http = require('http');
const sequelize = require('./config/database');
const routes = require('./routes');
const { metricsMiddleware } = require('./middlewares/metrics');
const { generalLimiter } = require('./middlewares/rateLimiter');
const errorHandler = require('./middlewares/errorHandler');
const notificationService = require('./services/notificationSocketService');

const app = express();
const server = http.createServer(app);

// Initialiser Socket.IO
notificationService.initialize(server);

// Middlewares de base
app.use(express.json());
app.use(compression()); // Compression des réponses
app.use(metricsMiddleware);

// Rate limiting global
app.use(generalLimiter);

// Endpoint de santé
app.get('/health', async (req, res) => {
  try {
    // Vérifier la connexion DB
    await sequelize.authenticate();

    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      environment: process.env.NODE_ENV || 'development',
      version: process.env.npm_package_version || '1.0.0'
    });
  } catch (error) {
    res.status(503).json({
      status: 'error',
      timestamp: new Date().toISOString(),
      error: 'Database connection failed'
    });
  }
});

// Routes API
app.use('/api', routes);

// Middleware de gestion d'erreurs (doit être après les routes)
app.use(errorHandler);

// Sync DB et démarrage serveur
const startServer = async () => {
  try {
    await sequelize.authenticate();
    console.log('✅ Connexion DB OK');

    await sequelize.sync({ alter: process.env.NODE_ENV === 'development' });
    console.log('✅ Base synchronisée');

    const PORT = process.env.PORT || 5500;
    server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
  } catch (err) {
    console.error('❌ Impossible de démarrer le serveur :', err);
    process.exit(1); // quitte si la DB est inaccessible
  }
};

startServer();
