'use strict';
const { body } = require('express-validator');

/**
 * Champs numériques de solde — chacun doit être >= 0 s'il est fourni.
 * jours_acquis peut aussi être transmis via les alias conges_acquis / solde_conges
 * (compatibilité normalizeCounterPayload).
 */
const nonNegativeOptional = (name) =>
  body(name)
    .optional({ nullable: true })
    .isFloat({ min: 0 }).withMessage(`${name} doit être >= 0`);

const upsertCounterRules = [
  body('conge_type_id')
    .isUUID().withMessage('conge_type_id doit être un UUID'),
  body('annee')
    .optional()
    .isInt({ min: 2000, max: 2100 }).withMessage('annee invalide (2000-2100)'),
  nonNegativeOptional('jours_acquis'),
  nonNegativeOptional('jours_pris'),
  nonNegativeOptional('jours_reportes'),
  nonNegativeOptional('jours_reserves'),
  // Alias acceptés par normalizeCounterPayload
  nonNegativeOptional('conges_acquis'),
  nonNegativeOptional('solde_conges'),
];

module.exports = { upsertCounterRules };
