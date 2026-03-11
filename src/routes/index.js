const express = require('express');
const router = express.Router();

const authRoutes = require('./auth');
const usersRoutes = require('./users');
const entrepriseRoutes = require('./entreprises');
const joursFeriesRoutes = require('./joursFeries');
const congesRoutes = require('./conge');

const authJwt = require('../middlewares/authJwt');
const authorizeRole = require('../middlewares/authorizeRole');
const sequelize = require('../config/database');

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
// route super_admin only
// ------------------------------
router.get('/admin_only', authJwt, authorizeRole(['super_admin']), (req, res) => {
  res.json({ message: 'Zone réservée aux super_admins' });
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

module.exports = router;