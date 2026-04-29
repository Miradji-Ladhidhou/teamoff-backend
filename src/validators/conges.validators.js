'use strict';
const { body } = require('express-validator');

const DEMI_JOURNEE = ['matin', 'apres_midi'];

// Re-normalise en "YYYY-MM-DD" par split — sans passer par new Date() pour éviter
// tout décalage UTC selon le timezone serveur.
// isISO8601({ strict: true }) en amont garantit que v est déjà bien formé.
const toDateString = (v) => {
  const parts = String(v).split('-');
  if (parts.length !== 3) return v;
  const [y, m, d] = parts;
  return `${y}-${m}-${d}`;
};

const dateField = (name) =>
  body(name)
    .isISO8601({ strict: true }).withMessage(`${name} invalide`)
    .customSanitizer(toDateString);

const optionalDateField = (name) =>
  body(name)
    .optional()
    .isISO8601({ strict: true }).withMessage(`${name} invalide`)
    .customSanitizer(toDateString);

/**
 * Création d'une demande de congé (POST /conges/demande)
 */
const createCongeRules = [
  body('conge_type_id')
    .isUUID().withMessage('conge_type_id doit être un UUID'),
  dateField('date_debut'),
  dateField('date_fin'),
  body('debut_demi_journee')
    .optional()
    .isIn(DEMI_JOURNEE).withMessage('debut_demi_journee invalide'),
  body('fin_demi_journee')
    .optional()
    .isIn(DEMI_JOURNEE).withMessage('fin_demi_journee invalide'),
  body('commentaire_employe')
    .optional({ nullable: true })
    .isString()
    .isLength({ max: 5000 }),
];

/**
 * Mise à jour d'un congé (PUT /conges/:id)
 * Tous les champs optionnels — modification partielle autorisée
 */
const updateCongeRules = [
  body('conge_type_id')
    .optional()
    .isUUID().withMessage('conge_type_id doit être un UUID'),
  optionalDateField('date_debut'),
  optionalDateField('date_fin'),
  body('debut_demi_journee')
    .optional()
    .isIn(DEMI_JOURNEE),
  body('fin_demi_journee')
    .optional()
    .isIn(DEMI_JOURNEE),
  body('commentaire_employe')
    .optional({ nullable: true })
    .isString()
    .isLength({ max: 5000 }),
  body('commentaire_manager')
    .optional({ nullable: true })
    .isString()
    .isLength({ max: 5000 }),
  body('commentaire_admin')
    .optional({ nullable: true })
    .isString()
    .isLength({ max: 5000 }),
];

/**
 * Vérification de chevauchement (POST /conges/check-overlap)
 */
const checkOverlapRules = [
  dateField('date_debut'),
  dateField('date_fin'),
];

module.exports = { createCongeRules, updateCongeRules, checkOverlapRules };
