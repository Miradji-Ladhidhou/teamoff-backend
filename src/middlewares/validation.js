const { body, param, query, validationResult } = require('express-validator');

// Middleware pour gérer les erreurs de validation
const handleValidationErrors = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      message: 'Données invalides',
      errors: errors.array()
    });
  }
  next();
};

// Validation pour la création d'un congé
const validateCongeCreation = [
  body('utilisateur_id').isUUID().withMessage('utilisateur_id doit être un UUID valide'),
  body('conge_type_id').isUUID().withMessage('conge_type_id doit être un UUID valide'),
  body('date_debut').isISO8601().withMessage('date_debut doit être une date valide'),
  body('date_fin').isISO8601().withMessage('date_fin doit être une date valide'),
  body('debut_demi_journee').optional().isIn(['matin', 'apres_midi']).withMessage('debut_demi_journee invalide'),
  body('fin_demi_journee').optional().isIn(['matin', 'apres_midi']).withMessage('fin_demi_journee invalide'),
  body('commentaire_employe').optional().isLength({ max: 1000 }).withMessage('commentaire trop long'),
  handleValidationErrors
];

// Validation pour la création d'une entreprise
const validateEntrepriseCreation = [
  body('nom').trim().isLength({ min: 2, max: 100 }).withMessage('nom doit contenir 2-100 caractères'),
  body('politique_conges').optional().isObject().withMessage('politique_conges doit être un objet'),
  handleValidationErrors
];

module.exports = {
  handleValidationErrors,
  validateCongeCreation,
  validateEntrepriseCreation
};