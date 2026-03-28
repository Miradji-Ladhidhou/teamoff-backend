require('dotenv').config();
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
const { initQuotasCron } = require('./cron/quotasCron');
const cors = require('cors');

const app = express();
app.set('trust proxy', 1);
const server = http.createServer(app);

// Initialiser Socket.IO
notificationService.initialize(server);

// ----------------------
// Configuration CORS
// ----------------------
const allowedOrigins = [process.env.FRONTEND_URL || 'https://teamoff-front.vercel.app'];

app.use(cors({
  origin: allowedOrigins,
  credentials: true,
}));

// ----------------------
// Middlewares de base
// ----------------------
app.use(express.json());
app.use(compression());
app.use(metricsMiddleware);

// Empêcher le rate limiter de bloquer les preflight OPTIONS
app.use((req, res, next) => {
  if (req.method === 'OPTIONS') return res.sendStatus(200);
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

// ----------------------
// Fonctions d'initialisation DB
// ----------------------
async function ensureUtilisateurTable() {
  await sequelize.query(`
    CREATE TABLE IF NOT EXISTS utilisateur (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email VARCHAR(255) NOT NULL UNIQUE,
      password VARCHAR(255) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

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
    CREATE TABLE IF NOT EXISTS jours_feries (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      libelle VARCHAR(255) NOT NULL,
      date DATE NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
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

async function ensureCompteurCongesColumns() {
  await sequelize.query(`
    CREATE TABLE IF NOT EXISTS compteur_conges (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      utilisateur_id UUID NOT NULL,
      jours_acquis NUMERIC(5,2) NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await sequelize.query(`
    ALTER TABLE compteur_conges
    ADD COLUMN IF NOT EXISTS dernier_credit_mensuel VARCHAR(7) NULL;
  `);
  await sequelize.query(`
    ALTER TABLE compteur_conges
    ADD COLUMN IF NOT EXISTS jours_annules NUMERIC(5,2) NOT NULL DEFAULT 0;
  `);
}

// ----------------------
// Démarrage serveur
// ----------------------
const startServer = async () => {
  try {
    await sequelize.authenticate();
    console.log('✅ Connexion DB OK');

    // Créer toutes les tables et colonnes manquantes
    await ensureUtilisateurTable();
    await ensureUtilisateurAuthColumns();
    await ensureJoursFeriesColumns();
    await ensureHolidayTemplateTables();
    await ensureCompteurCongesColumns();

    // Synchroniser les modèles Sequelize (création/mise à jour tables)
    await sequelize.sync({ alter: true });
    console.log('✅ Base synchronisée');

    // Initialiser le cron de sauvegarde automatique
    await initBackupCron();
    initQuotasCron();

    const PORT = process.env.PORT || 5500;
    server.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
    });

  } catch (err) {
    console.error('❌ Impossible de démarrer le serveur :', err);
    process.exit(1);
  }
};

if (require.main === module) {
  startServer();
}

module.exports = app;