// routes/joursFeriesRoutes.js
const express = require('express');
const router = express.Router();
const authJwt = require('../middlewares/authJwt');
const authorizeRole = require('../middlewares/authorizeRole');
const {
	listerJoursFeries,
	creerJourFerie,
	getJourFerie,
	updateJourFerie,
	supprimerJourFerie,
	importerJoursFeriesNationaux,
	listerModelesJoursFeries,
	creerModeleJoursFeries,
	exporterModeleJoursFeriesCsv,
	importerModeleJoursFeriesCsv,
	appliquerModeleJoursFeries,
} = require('../controllers/joursFeriesController');

// Routes pour les jours fériés

// recupérer tous les jours fériés
router.get('/', authJwt, authorizeRole(['admin_entreprise', 'super_admin']), listerJoursFeries);

// créer un jour férié
router.post('/', authJwt, authorizeRole(['admin_entreprise', 'super_admin']), creerJourFerie);

// importer les jours fériés nationaux via API externe
router.post('/import/:year', authJwt, authorizeRole(['admin_entreprise', 'super_admin']), importerJoursFeriesNationaux);

// modèles de jours fériés (copier/coller/export/import)
router.get('/templates', authJwt, authorizeRole(['admin_entreprise', 'super_admin']), listerModelesJoursFeries);
router.post('/templates', authJwt, authorizeRole(['admin_entreprise', 'super_admin']), creerModeleJoursFeries);
router.post('/templates/import/csv', authJwt, authorizeRole(['admin_entreprise', 'super_admin']), importerModeleJoursFeriesCsv);
router.get('/templates/:id/export/csv', authJwt, authorizeRole(['admin_entreprise', 'super_admin']), exporterModeleJoursFeriesCsv);
router.post('/templates/:id/apply', authJwt, authorizeRole(['admin_entreprise', 'super_admin']), appliquerModeleJoursFeries);

// récupérer un jour férié par ID
router.get('/:id', authJwt, authorizeRole(['admin_entreprise', 'super_admin']), getJourFerie);

// mettre à jour un jour férié
router.put('/:id', authJwt, authorizeRole(['admin_entreprise', 'super_admin']), updateJourFerie);

// supprimer un jour férié
router.delete('/:id', authJwt, authorizeRole(['admin_entreprise', 'super_admin']), supprimerJourFerie);

module.exports = router;