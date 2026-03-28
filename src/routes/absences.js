
// Routes Express pour la gestion des absences TeamOff
const express = require('express');
const router = express.Router();
const authJwt = require('../middlewares/authJwt');
const upload = require('../middlewares/uploadJustificatif');
const absenceController = require('../controllers/absenceController');

// Middleware de droits pour la consultation des absences
function canViewAbsences(req, res, next) {
  if (["super_admin", "admin_entreprise", "manager"].includes(req.user.role)) return next();
  if (req.query.utilisateur_id && req.query.utilisateur_id !== req.user.id) {
    return res.status(403).json({ message: "Accès interdit" });
  }
  next();
}

// Toutes les routes nécessitent l'authentification JWT
router.use(authJwt);

/**
 * POST /api/absences
 * Création d'une absence avec upload de justificatif (optionnel)
 * - type_absence, date_debut, date_fin, commentaire (dans body)
 * - justificatif (fichier, champ 'justificatif')
 */
router.post('/', upload.single('justificatif'), absenceController.createAbsence);

/**
 * GET /api/absences
 * Liste des absences, avec filtres et droits
 */
router.get('/', canViewAbsences, absenceController.listAbsences);

/**
 * PATCH /api/absences/:id
 * Mise à jour du justificatif ou commentaire (selon droits)
 */
router.patch('/:id', absenceController.updateAbsence);

module.exports = router;
