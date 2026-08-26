
// Routes Express pour la gestion des absences TeamOff
const express = require('express');
const router = express.Router();
const validateUUIDParam = require('../middlewares/validateUUIDParam');
const absenceController = require('../controllers/absenceController');

// Middleware de droits pour la consultation des absences
function canViewAbsences(req, res, next) {
  if (["super_admin", "admin_entreprise", "manager"].includes(req.user.role)) return next();
  if (req.query.utilisateur_id && req.query.utilisateur_id !== req.user.id) {
    return res.status(403).json({ message: "Accès interdit" });
  }
  next();
}


/**
 * POST /api/absences
 * Création d'une absence avec upload de justificatif (optionnel)
 * - type_absence, date_debut, date_fin, commentaire (dans body)
 * - justificatif (fichier, champ 'justificatif')
 */
router.post('/', absenceController.createAbsence);

/**
 * GET /api/absences
 * Liste des absences, avec filtres et droits
 */
router.get('/', canViewAbsences, absenceController.listAbsences);

/**
 * PATCH /api/absences/:id
 * Mise à jour du justificatif ou commentaire (selon droits)
 */
router.patch('/:id', validateUUIDParam('id'), absenceController.updateAbsence);

/**
 * DELETE /api/absences/:id
 * Suppression d'une absence.
 * - Employé : uniquement la sienne, si statut === 'signalée'
 * - Manager / admin_entreprise : toute absence de leur entreprise
 * - super_admin : toute absence
 */
router.delete('/:id', validateUUIDParam('id'), absenceController.deleteAbsence);

module.exports = router;
