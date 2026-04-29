const express = require('express');
const router = express.Router();
const authorizeRole = require('../middlewares/authorizeRole');
const { body } = require('express-validator');
const validateUUIDParam = require('../middlewares/validateUUIDParam');
const entreprisesController = require('../controllers/entreprisesController');


// Routes pour les entreprises

// creation d'une entreprise (super_admin uniquement)
router.post('/', authorizeRole(['super_admin']), entreprisesController.createEntreprise);

// récupération de toutes les entreprises (super_admin uniquement)
router.get('/', authorizeRole(['super_admin']), entreprisesController.getAllEntreprises);

// récupération d'une entreprise par ID (super_admin et admin_entreprise de l'entreprise concernée)
router.get('/:id', authorizeRole(['super_admin', 'admin_entreprise'], req => req.params.id), validateUUIDParam('id'), entreprisesController.getEntrepriseById);

// mise à jour d'une entreprise (super_admin uniquement)
router.put('/:id', authorizeRole(['super_admin']), validateUUIDParam('id'), entreprisesController.updateEntreprise);

// suppression d'une entreprise (super_admin uniquement)
router.delete('/:id', authorizeRole(['super_admin']), validateUUIDParam('id'), entreprisesController.deleteEntreprise);

// changement de statut d'une entreprise (super_admin uniquement)
router.patch('/:id/statut', authorizeRole(['super_admin']), validateUUIDParam('id'), entreprisesController.patchStatutEntreprise);

// jours bloqués — accessible à tous les rôles authentifiés de l'entreprise
router.get('/:id/blocked-days', authorizeRole(['super_admin', 'admin_entreprise', 'manager', 'employe']), validateUUIDParam('id'), entreprisesController.getBlockedDays);

// gestion de la politique de congés d'une entreprise (super_admin et admin_entreprise de l'entreprise concernée)
router.get('/:id/politique', authorizeRole(['super_admin', 'admin_entreprise'], req => req.params.id), validateUUIDParam('id'), entreprisesController.getPolitiqueConges);

// mise à jour de la politique de congés d'une entreprise (super_admin et admin_entreprise de l'entreprise concernée)
router.put('/:id/politique', authorizeRole(['super_admin', 'admin_entreprise'], req => req.params.id), validateUUIDParam('id'),
  body('politique_conges').isObject().withMessage('Politique_conges doit être un objet JSON'),
  entreprisesController.updatePolitiqueConges
);

// gestion des paramètres généraux d'une entreprise (super_admin et admin_entreprise de l'entreprise concernée)
router.get('/:id/parametres', authorizeRole(['super_admin', 'admin_entreprise'], req => req.params.id), validateUUIDParam('id'), entreprisesController.getParametres);
router.put('/:id/parametres', authorizeRole(['super_admin', 'admin_entreprise'], req => req.params.id), validateUUIDParam('id'), entreprisesController.updateParametres);

// gestion des services d'une entreprise (super_admin et admin_entreprise de l'entreprise concernée)
router.get('/:id/services', authorizeRole(['super_admin', 'admin_entreprise'], req => req.params.id), validateUUIDParam('id'), entreprisesController.getEntrepriseServices);
router.post('/:id/services', authorizeRole(['super_admin', 'admin_entreprise'], req => req.params.id), validateUUIDParam('id'), entreprisesController.createEntrepriseService);
router.put('/:id/services/:serviceName', authorizeRole(['super_admin', 'admin_entreprise'], req => req.params.id), validateUUIDParam('id'), entreprisesController.updateEntrepriseService);
router.delete('/:id/services/:serviceName', authorizeRole(['super_admin', 'admin_entreprise'], req => req.params.id), validateUUIDParam('id'), entreprisesController.deleteEntrepriseService);

module.exports = router;