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
const emailLogsRoutes = require('./emailLogs');

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
      attributes: ['id', 'nom', 'prenom', 'email', 'role', 'entreprise_id', 'statut', 'service', 'date_embauche', 'totp_enabled', 'delegue_id'],
      include: [{ model: Utilisateur, as: 'delegue', attributes: ['id', 'prenom', 'nom'], required: false }],
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
      totp_enabled: user.totp_enabled ?? false,
      delegue_id: user.delegue_id || null,
      delegue: user.delegue ? { id: user.delegue.id, prenom: user.delegue.prenom, nom: user.delegue.nom } : null,
    });
  } catch (err) {
    res.status(500).json({ message: 'Erreur serveur' });
  }
});

router.put('/me', authJwt, require('../middlewares/advancedRateLimiter').advancedRateLimiter('profileUpdate'), usersController.updateOwnProfile);

router.put('/me/delegate', authJwt, require('../middlewares/advancedRateLimiter').advancedRateLimiter('profileUpdate'), async (req, res) => {
  try {
    const { Utilisateur } = require('../models');
    const { delegue_id } = req.body;

    const utilisateur = await Utilisateur.findByPk(req.user.id);
    if (!utilisateur) return res.status(404).json({ message: 'Utilisateur introuvable.' });

    if (!delegue_id) {
      await utilisateur.update({ delegue_id: null });
      return res.json({ message: 'Délégation supprimée.', delegue_id: null, delegue: null });
    }

    if (delegue_id === req.user.id) {
      return res.status(400).json({ message: 'Vous ne pouvez pas vous déléguer à vous-même.' });
    }

    const delegue = await Utilisateur.findByPk(delegue_id, { attributes: ['id', 'prenom', 'nom', 'entreprise_id', 'statut'] });
    if (!delegue || delegue.entreprise_id !== utilisateur.entreprise_id) {
      return res.status(404).json({ message: 'Collaborateur introuvable.' });
    }
    if (delegue.statut !== 'actif') {
      return res.status(400).json({ message: 'Le collaborateur doit être actif.' });
    }

    await utilisateur.update({ delegue_id });
    res.json({
      message: 'Délégation mise à jour.',
      delegue_id,
      delegue: { id: delegue.id, prenom: delegue.prenom, nom: delegue.nom },
    });
  } catch (err) {
    res.status(500).json({ message: 'Erreur serveur.' });
  }
});

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
    const daysToKeep = hasInput ? Number(rawDaysToKeep) : MonitoringService.MIN_RETENTION_DAYS;

    if (!Number.isFinite(daysToKeep) || daysToKeep < MonitoringService.MIN_RETENTION_DAYS) {
      return res.status(400).json({
        message: `daysToKeep doit être ≥ ${MonitoringService.MIN_RETENTION_DAYS} jours (politique de rétention minimale)`,
      });
    }

    const result = await MonitoringService.cleanupOldMetrics(daysToKeep, req.user);
    res.status(200).json({ message: 'Nettoyage des métriques terminé', ...result });
  } catch (error) {
    if (error.code === 'RETENTION_TOO_SHORT') {
      return res.status(400).json({ message: error.message });
    }
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
// Email logs routes (super_admin uniquement)
// ------------------------------
router.use('/email-logs', authJwt, emailLogsRoutes);

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