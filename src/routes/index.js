const express = require('express');
const router = express.Router();

const authJwt = require('../middlewares/authJwt');
const authorizeRole = require('../middlewares/authorizeRole');

const congesRoutes = require('./congeRoutes');
const entrepriseRoutes = require('./entrepriseRoutes');
const joursFeriesRoutes = require('./joursFeriesRoutes');
const authRoutes = require('./auth');
const usersRoutes = require('./users');


// ------------------------------
// Healthcheck
// ------------------------------
router.get('/health', async (req, res) => {
  const sequelize = require('../config/database');

  try {
    await sequelize.authenticate();

    res.status(200).json({
      status: 'ok',
      db: 'connected'
    });

  } catch (err) {

    res.status(500).json({
      status: 'error',
      db: 'disconnected',
      error: err.message
    });

  }
});


// ------------------------------
// Auth routes
// ------------------------------
router.use('/auth', authRoutes);


// ------------------------------
// Users routes
// ------------------------------
router.use('/users', authJwt, usersRoutes);


// ------------------------------
// Entreprise routes
// ------------------------------
router.use('/entreprises', authJwt, entrepriseRoutes);


// ------------------------------
// Jours fériés routes
// ------------------------------
router.use('/jours-feries', authJwt, joursFeriesRoutes);


// ------------------------------
// Congés routes
// ------------------------------
router.use('/conges', authJwt, congesRoutes);


// ------------------------------
// Route utilisateur connecté
// ------------------------------
router.get('/me', authJwt, (req, res) => {
  res.json({
    message: 'Accès autorisé',
    user: req.user
  });
});


// ------------------------------
// Route réservée aux super_admin uniquement
// ------------------------------
router.get(
  '/admin_only',
  authJwt,
  authorizeRole(['super_admin']),
  (req, res) => {

    res.json({
      message: 'Zone réservée aux super_admins'
    });

  }
);


// ------------------------------
// Dashboard entreprise
// ------------------------------
router.get(
  '/company-dashboard/:entreprise_id',
  authJwt,
  authorizeRole(
    ['super_admin', 'admin_entreprise'],
    req => req.params.entreprise_id
  ),
  (req, res) => {

    res.json({
      message: 'Dashboard entreprise',
      entreprise_id: req.params.entreprise_id
    });

  }
);


// ------------------------------
// Dashboard manager
// ------------------------------
router.get(
  '/manager-dashboard/:entreprise_id',
  authJwt,
  authorizeRole(
    ['super_admin', 'admin_entreprise', 'manager'],
    req => req.params.entreprise_id
  ),
  (req, res) => {

    res.json({
      message: 'Dashboard manager',
      entreprise_id: req.params.entreprise_id
    });

  }
);


// ------------------------------
// Dashboard employé
// ------------------------------
router.get(
  '/employee-dashboard/:entreprise_id',
  authJwt,
  authorizeRole(
    ['super_admin', 'admin_entreprise', 'employe'],
    req => req.params.entreprise_id
  ),
  (req, res) => {

    res.json({
      message: 'Dashboard employé',
      entreprise_id: req.params.entreprise_id
    });

  }
);


// ------------------------------
// Route test simple
// ------------------------------
router.get('/', (req, res) => {
  res.send('TeamOff Backend en marche !');
});


module.exports = router;