// src/routes/index.js
const express = require('express');
const router = express.Router();
const sequelize = require('../config/database');

// ------------------------------
// Middlewares & services
// ------------------------------
const authJwt = require('../middlewares/authJwt');
const authorizeRole = require('../middlewares/authorizeRole');
const usersController = require('../controllers/usersController');
const { metricsMiddleware, getMetrics } = require('../middlewares/metrics');
const MonitoringService = require('../services/monitoringService');

// ------------------------------
// Route modules
// ------------------------------
const authRoutes = require('./auth');
const twoFactorRoutes = require('./twoFactor');
const usersRoutes = require('./users');
const entrepriseRoutes = require('./entreprises');
const joursFeriesRoutes = require('./joursFeries');
const congesRoutes = require('./conge');
const notificationRoutes = require('./notification');
const congeTypesRoutes = require('./congeTypes');
const leavePoliciesRoutes = require('./leavePolicies');
const settingsRoutes = require('./settings');
const quotasRoutes = require('./quotas');
const calendrierRoutes = require('./calendrier');
const exportRoutes = require('./exports');
const auditRoutes = require('./audit');
const absencesRoutes = require('./absences');

// ------------------------------
// Appliquer les métriques à toutes les routes
// ------------------------------
router.use(metricsMiddleware);

// ------------------------------
// Healthcheck
// ------------------------------
router.get('/health', async (req, res) => {
  try {
    await sequelize.authenticate();
    res.status(200).json({ status: 'ok', db: 'connected' });
  } catch (err) {
    res.status(500).json({ status: 'error', db: 'disconnected' });
  }
});

// ------------------------------
// Auth routes (open)
// ------------------------------
router.use('/auth', authRoutes);

// ------------------------------
// 2FA routes (mixed: some open, some auth-protected)
// ------------------------------
router.use('/auth/2fa', twoFactorRoutes);

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
router.get('/me', authJwt, async (req, res) => {
  try {
    const { Utilisateur, Entreprise } = require('../models');
    const user = await Utilisateur.findByPk(req.user.id, {
      attributes: ['id', 'nom', 'prenom', 'email', 'role', 'entreprise_id', 'statut', 'service', 'date_embauche'],
    });
    if (!user) return res.status(404).json({ message: 'Utilisateur introuvable' });
    const entreprise = await Entreprise.findByPk(user.entreprise_id, { attributes: ['id', 'nom'] });
    res.json({
      id: user.id,
      nom: user.nom,
      prenom: user.prenom,
      email: user.email,
      role: user.role,
      entreprise_id: user.entreprise_id,
      entreprise_nom: entreprise?.nom || null,
      statut: user.statut,
      service: user.service,
      date_embauche: user.date_embauche,
    });
  } catch (err) {
    res.status(500).json({ message: 'Erreur serveur' });
  }
});

router.put('/me', authJwt, require('../middlewares/advancedRateLimiter').advancedRateLimiter('login'), usersController.updateOwnProfile);

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
      return res.status(400).json({ message: 'daysToKeep doit être un nombre strictement positif' });
    }

    const result = await MonitoringService.cleanupOldMetrics(daysToKeep);
    res.status(200).json({ message: 'Nettoyage des métriques terminé', ...result });
  } catch (error) {
    res.status(500).json({ message: 'Impossible de nettoyer les métriques' });
  }
});

// ------------------------------
// Quotas routes (auth requis)
// ------------------------------
router.use('/quotas', authJwt, quotasRoutes);

// ------------------------------
// Calendrier des congés routes (auth requis)
// ------------------------------
router.use('/calendrier-conges', authJwt, calendrierRoutes);

// ------------------------------
// Notifications routes (auth requis)
// ------------------------------
router.use('/notifications', authJwt, notificationRoutes);

// ------------------------------
// Types de congé routes (auth requis)
// ------------------------------
router.use('/conge-types', authJwt, congeTypesRoutes);

// ------------------------------
// Exports routes (admin uniquement)
// ------------------------------
router.use('/exports', authJwt, exportRoutes);

// ------------------------------
// Audit logs routes (super_admin uniquement)
// ------------------------------
router.use('/audit', authJwt, auditRoutes);

// ------------------------------
// System settings routes (super_admin uniquement)
// ------------------------------
router.use('/settings', authJwt, settingsRoutes);

// ------------------------------
// Absences routes (auth requis)
// ------------------------------
router.use('/absences', authJwt, absencesRoutes);

// Leave Policies routes (auth requis - admin_entreprise, super_admin pour modification)
// ------------------------------
router.use('/leave-policies', authJwt, leavePoliciesRoutes);

module.exports = router;