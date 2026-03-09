// routes/joursFeriesRoutes.js
const express = require('express');
const router = express.Router();
const authJwt = require('../middlewares/authJwt');
const authorizeRole = require('../middlewares/authorizeRole');
const { listerJoursFeries, creerJourFerie, getJourFerie, updateJourFerie, supprimerJourFerie } = require('../controllers/joursFeriesController');

// Routes pour les jours fériés

// recupérer tous les jours fériés
router.get('/', authJwt, authorizeRole(['admin_entreprise', 'super_admin']), listerJoursFeries);

// créer un jour férié
router.post('/', authJwt, authorizeRole(['admin_entreprise', 'super_admin']), creerJourFerie);

// récupérer un jour férié par ID
router.get('/:id', authJwt, authorizeRole(['admin_entreprise', 'super_admin']), getJourFerie);

// mettre à jour un jour férié
router.put('/:id', authJwt, authorizeRole(['admin_entreprise', 'super_admin']), updateJourFerie);

// supprimer un jour férié
router.delete('/:id', authJwt, authorizeRole(['admin_entreprise', 'super_admin']), supprimerJourFerie);

module.exports = router;