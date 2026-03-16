const express = require('express');
const router = express.Router();

const authRoutes = require('./auth');
const usersRoutes = require('./users');
const entrepriseRoutes = require('./entreprises');
const joursFeriesRoutes = require('./joursFeries');
const congesRoutes = require('./conge');
const notificationRoutes = require('./notification');
const congeTypesRoutes = require('./congeTypes');

const authJwt = require('../middlewares/authJwt');
const authorizeRole = require('../middlewares/authorizeRole');
const { generalLimiter } = require('../middlewares/rateLimiter');
const { metricsMiddleware, getMetrics } = require('../middlewares/metrics');
const sequelize = require('../config/database');

// Appliquer rate limiter général à toutes les routes
router.use(generalLimiter);

// Appliquer métriques à toutes les routes
router.use(metricsMiddleware);

// ------------------------------
// Healthcheck
// ------------------------------
router.get('/health', async (req, res) => {
  try {
    await sequelize.authenticate();
    res.status(200).json({ status: 'ok', db: 'connected' });
  } catch (err) {
    res.status(500).json({ status: 'error', db: 'disconnected', error: err.message });
  }
});

// ------------------------------
// Auth routes
// ------------------------------
router.use('/auth', authRoutes);

// ------------------------------
// Users routes (auth requis)
// ------------------------------
router.use('/users', authJwt, usersRoutes);

// ------------------------------
// Entreprises routes (auth requis)
// ------------------------------
router.use('/entreprises', authJwt, entrepriseRoutes);

// ------------------------------
// Jours fériés routes (auth requis)
// ------------------------------
router.use('/jours-feries', authJwt, joursFeriesRoutes);

// ------------------------------
// Congés routes (auth requis)
// ------------------------------
router.use('/conges', authJwt, congesRoutes);

// ------------------------------
// Infos utilisateur connecté
// ------------------------------
router.get('/me', authJwt, (req, res) => {
  res.json({ message: 'Accès autorisé', user: req.user });
});

// ------------------------------
// Métriques (super_admin uniquement)
// ------------------------------
router.get('/metrics', authJwt, authorizeRole(['super_admin']), getMetrics);

// ------------------------------
// Quotas routes (auth requis)
// ------------------------------
const quotasRoutes = require('./quotas'); 
router.use('/quotas', authJwt, quotasRoutes);

// ------------------------------
// Calendrier des congés routes (auth requis)
// ------------------------------
const calendrierRoutes = require('./calendrier');
router.use('/calendrier-conges', authJwt, calendrierRoutes);

// ------------------------------
// Notifications routes (auth requis)
// ------------------------------
router.use('/notifications', authJwt, notificationRoutes);

// ----------------------------
// Types de congé routes (auth requis)
// ----------------------------
router.use('/conge-types', authJwt, congeTypesRoutes);

// ------------------------------
// Exports routes (admin uniquement)
// ------------------------------
const exportRoutes = require('./exports');
router.use('/exports', authJwt, exportRoutes);

module.exports = router;