// routes/joursFeriesRoutes.js
const express = require('express');
const router = express.Router();
const authorizeRole = require('../middlewares/authorizeRole');
const validateUUIDParam = require('../middlewares/validateUUIDParam');
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
	getJoursFeriesByMonth,
} = require('../controllers/joursFeriesController');

// Routes pour les jours fériés

// recupérer tous les jours fériés
router.get('/', authorizeRole(['admin_entreprise', 'super_admin']), listerJoursFeries);

// créer un jour férié
router.post('/', authorizeRole(['admin_entreprise', 'super_admin']), creerJourFerie);

// importer les jours fériés nationaux via API externe
router.post('/import/:year', authorizeRole(['admin_entreprise', 'super_admin']), importerJoursFeriesNationaux);

// modèles de jours fériés (copier/coller/export/import)
router.get('/templates', authorizeRole(['admin_entreprise', 'super_admin']), listerModelesJoursFeries);
router.post('/templates', authorizeRole(['admin_entreprise', 'super_admin']), creerModeleJoursFeries);
router.post('/templates/import/csv', authorizeRole(['admin_entreprise', 'super_admin']), importerModeleJoursFeriesCsv);
router.get('/templates/:id/export/csv', authorizeRole(['admin_entreprise', 'super_admin']), validateUUIDParam('id'), exporterModeleJoursFeriesCsv);
router.post('/templates/:id/apply', authorizeRole(['admin_entreprise', 'super_admin']), validateUUIDParam('id'), appliquerModeleJoursFeries);

// récupérer un jour férié par ID
// jours fériés par mois — accessible à tous les rôles (page calendrier)
router.get('/:year/:month', getJoursFeriesByMonth);

// récupérer un jour férié par ID
router.get('/:id', authorizeRole(['admin_entreprise', 'super_admin']), validateUUIDParam('id'), getJourFerie);

// mettre à jour un jour férié
router.put('/:id', authorizeRole(['admin_entreprise', 'super_admin']), validateUUIDParam('id'), updateJourFerie);

// supprimer un jour férié
router.delete('/:id', authorizeRole(['admin_entreprise', 'super_admin']), validateUUIDParam('id'), supprimerJourFerie);

module.exports = router;