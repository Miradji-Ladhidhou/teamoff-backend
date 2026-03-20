const express = require('express');
const router = express.Router();

const authRoutes = require('./auth');
const usersRoutes = require('./users');
const entrepriseRoutes = require('./entreprises');
const joursFeriesRoutes = require('./joursFeries');
const congesRoutes = require('./conge');
const notificationRoutes = require('./notification');
const congeTypesRoutes = require('./congeTypes');
const settingsRoutes = require('./settings');

const authJwt = require('../middlewares/authJwt');
const usersController = require('../controllers/usersController');
const authorizeRole = require('../middlewares/authorizeRole');
// const { generalLimiter } = require('../middlewares/rateLimiter');
const { metricsMiddleware, getMetrics } = require('../middlewares/metrics');
const MonitoringService = require('../services/monitoringService');
const sequelize = require('../config/database');

// Le rate limiting avancé est appliqué par route critique (voir middlewares/advancedRateLimiter.js)

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

// Mise à jour du propre profil (tous les utilisateurs authentifiés)
router.put('/me', authJwt, usersController.updateOwnProfile);

// ------------------------------
// Métriques (super_admin uniquement)
// ------------------------------
router.get('/metrics', authJwt, authorizeRole(['super_admin']), getMetrics);

// ------------------------------
// Monitoring santé système (super_admin uniquement)
// ------------------------------
router.get('/monitoring/health', authJwt, authorizeRole(['super_admin']), async (req, res) => {
  try {
    const report = await MonitoringService.getHealthReport();
    const statusCode = report.status === 'healthy' ? 200 : 503;
    res.status(statusCode).json(report);
  } catch (error) {
    res.status(500).json({
      status: 'unhealthy',
      message: 'Impossible de récupérer le rapport de santé',
      error: error.message,
    });
  }
});

// ------------------------------
// Monitoring cleanup (super_admin uniquement)
// ------------------------------
router.post('/monitoring/cleanup', authJwt, authorizeRole(['super_admin']), async (req, res) => {
  try {
    const rawDaysToKeep = req.body?.daysToKeep;
    const hasInput = rawDaysToKeep !== undefined && rawDaysToKeep !== null && rawDaysToKeep !== '';
    const daysToKeep = hasInput ? Number(rawDaysToKeep) : 30;

    if (!Number.isFinite(daysToKeep) || daysToKeep <= 0) {
      return res.status(400).json({
        message: 'daysToKeep doit être un nombre strictement positif'
      });
    }

    const result = await MonitoringService.cleanupOldMetrics(daysToKeep);
    return res.status(200).json({
      message: 'Nettoyage des métriques terminé',
      ...result,
    });
  } catch (error) {
    return res.status(500).json({
      message: 'Impossible de nettoyer les métriques',
      error: error.message,
    });
  }
});

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

// ------------------------------
// Audit logs routes (super_admin uniquement)
// ------------------------------
const auditRoutes = require('./audit');
router.use('/audit', authJwt, auditRoutes);

// ------------------------------
// System settings routes (super_admin uniquement)
// ------------------------------
router.use('/settings', authJwt, settingsRoutes);

module.exports = router;