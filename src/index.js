const express = require('express');
const compression = require('compression');
const http = require('http');
const sequelize = require('./config/database');
const routes = require('./routes');
const { metricsMiddleware } = require('./middlewares/metrics');
const { generalLimiter } = require('./middlewares/rateLimiter');
const errorHandler = require('./middlewares/errorHandler');
const notificationService = require('./services/notificationSocketService');
const maintenanceMode = require('./middlewares/maintenanceMode');
const { initBackupCron } = require('./cron/backupCron');
const cors = require('cors');

const app = express();
const server = http.createServer(app);

// Initialiser Socket.IO
notificationService.initialize(server);

// ----------------------
// Configuration CORS
// ----------------------
const corsOptions = {
  origin: 'http://localhost:3001',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
};

app.use(cors(corsOptions));

// ----------------------
// Middlewares de base
// ----------------------
app.use(express.json());
app.use(compression());
app.use(metricsMiddleware);

// Empêcher le rate limiter de bloquer les preflight OPTIONS
app.use((req, res, next) => {
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Rate limiting global
app.use(generalLimiter);

// ----------------------
// Endpoint de santé
// ----------------------
app.get('/health', async (req, res) => {
  try {
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

// ----------------------
// Routes API
// ----------------------
app.use(maintenanceMode);
app.use('/api', routes);

// ----------------------
// Gestion des erreurs
// ----------------------
app.use(errorHandler);

async function ensureUtilisateurAuthColumns() {
  await sequelize.query(`
    ALTER TABLE utilisateur
    ADD COLUMN IF NOT EXISTS failed_login_attempts INTEGER NOT NULL DEFAULT 0;
  `);

  await sequelize.query(`
    ALTER TABLE utilisateur
    ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ NULL;
  `);
}

async function ensureJoursFeriesColumns() {
  await sequelize.query(`
    ALTER TABLE jours_feries
    ADD COLUMN IF NOT EXISTS recurrent BOOLEAN NOT NULL DEFAULT false;
  `);

  await sequelize.query(`
    ALTER TABLE jours_feries
    ADD COLUMN IF NOT EXISTS est_travail BOOLEAN NOT NULL DEFAULT false;
  `);
}

async function ensureHolidayTemplateTables() {
  await sequelize.query(`
    CREATE TABLE IF NOT EXISTS holiday_templates (
      id UUID PRIMARY KEY,
      name VARCHAR(150) NOT NULL,
      region VARCHAR(120),
      country_code VARCHAR(2) NOT NULL DEFAULT 'FR',
      created_by UUID,
      source_entreprise_id UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await sequelize.query(`
    CREATE TABLE IF NOT EXISTS holiday_template_items (
      id UUID PRIMARY KEY,
      template_id UUID NOT NULL,
      date DATE NOT NULL,
      libelle VARCHAR(255) NOT NULL,
      recurrent BOOLEAN NOT NULL DEFAULT false,
      est_travail BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT holiday_template_items_template_date_unique UNIQUE (template_id, date)
    );
  `);
}

// ----------------------
// Démarrage serveur
// ----------------------
const startServer = async () => {
  try {

    await sequelize.authenticate();
    console.log('✅ Connexion DB OK');

    await ensureUtilisateurAuthColumns();
    console.log('✅ Colonnes auth utilisateur vérifiées');

    await ensureJoursFeriesColumns();
    console.log('✅ Colonnes jours fériés vérifiées');

    await ensureHolidayTemplateTables();
    console.log('✅ Tables modèles jours fériés vérifiées');

    await sequelize.sync({ alter: process.env.NODE_ENV === 'development' });
    console.log('✅ Base synchronisée');

    // Initialiser le cron de sauvegarde automatique
    await initBackupCron();

    const PORT = process.env.PORT || 5500;

    server.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
    });

  } catch (err) {

    console.error('❌ Impossible de démarrer le serveur :', err);
    process.exit(1);

  }
};

startServer();