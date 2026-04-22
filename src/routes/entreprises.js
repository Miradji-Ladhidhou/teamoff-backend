const express = require('express');
const router = express.Router();
const authJwt = require('../middlewares/authJwt');
const authorizeRole = require('../middlewares/authorizeRole');
const { body } = require('express-validator');
const entreprisesController = require('../controllers/entreprisesController');


// Routes pour les entreprises

// creation d'une entreprise (super_admin uniquement)
router.post('/', authJwt, authorizeRole(['super_admin']), entreprisesController.createEntreprise);

// récupération de toutes les entreprises (super_admin uniquement)
router.get('/', authJwt, authorizeRole(['super_admin']), entreprisesController.getAllEntreprises);

// récupération d'une entreprise par ID (super_admin et admin_entreprise de l'entreprise concernée)
router.get('/:id', authJwt, authorizeRole(['super_admin', 'admin_entreprise'], req => req.params.id), entreprisesController.getEntrepriseById);

// mise à jour d'une entreprise (super_admin uniquement)
router.put('/:id', authJwt, authorizeRole(['super_admin']), entreprisesController.updateEntreprise);

// suppression d'une entreprise (super_admin uniquement)
router.delete('/:id', authJwt, authorizeRole(['super_admin']), entreprisesController.deleteEntreprise);

// changement de statut d'une entreprise (super_admin uniquement)
router.patch('/:id/statut', authJwt, authorizeRole(['super_admin']), entreprisesController.patchStatutEntreprise);

// jours bloqués — accessible à tous les rôles authentifiés de l'entreprise
router.get('/:id/blocked-days', authJwt, authorizeRole(['super_admin', 'admin_entreprise', 'manager', 'employe']), entreprisesController.getBlockedDays);

// gestion de la politique de congés d'une entreprise (super_admin et admin_entreprise de l'entreprise concernée)
router.get('/:id/politique', authJwt, authorizeRole(['super_admin', 'admin_entreprise'], req => req.params.id), entreprisesController.getPolitiqueConges);

// mise à jour de la politique de congés d'une entreprise (super_admin et admin_entreprise de l'entreprise concernée)
router.put('/:id/politique', authJwt, authorizeRole(['super_admin', 'admin_entreprise'], req => req.params.id),
  body('politique_conges').isObject().withMessage('Politique_conges doit être un objet JSON'),
  entreprisesController.updatePolitiqueConges
);

// gestion des paramètres généraux d'une entreprise (super_admin et admin_entreprise de l'entreprise concernée)
router.get('/:id/parametres', authJwt, authorizeRole(['super_admin', 'admin_entreprise'], req => req.params.id), entreprisesController.getParametres);
router.put('/:id/parametres', authJwt, authorizeRole(['super_admin', 'admin_entreprise'], req => req.params.id), entreprisesController.updateParametres);

// gestion des services d'une entreprise (super_admin et admin_entreprise de l'entreprise concernée)
router.get('/:id/services', authJwt, authorizeRole(['super_admin', 'admin_entreprise'], req => req.params.id), entreprisesController.getEntrepriseServices);
router.post('/:id/services', authJwt, authorizeRole(['super_admin', 'admin_entreprise'], req => req.params.id), entreprisesController.createEntrepriseService);
router.put('/:id/services/:serviceName', authJwt, authorizeRole(['super_admin', 'admin_entreprise'], req => req.params.id), entreprisesController.updateEntrepriseService);
router.delete('/:id/services/:serviceName', authJwt, authorizeRole(['super_admin', 'admin_entreprise'], req => req.params.id), entreprisesController.deleteEntrepriseService);

module.exports = router;