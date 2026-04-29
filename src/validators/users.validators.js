'use strict';
const { body } = require('express-validator');

const VALID_ROLES = ['super_admin', 'admin_entreprise', 'manager', 'employe'];
const VALID_STATUTS = ['actif', 'inactif', 'en_attente'];
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Règles de création d'un utilisateur
 */
const createUserRules = [
  body('nom')
    .isString().withMessage('nom invalide')
    .trim()
    .notEmpty()
    .isLength({ max: 255 }),
  body('prenom')
    .optional({ nullable: true })
    .isString()
    .isLength({ max: 255 }),
  body('email')
    .isString().trim().notEmpty()
    .isLength({ max: 255 }),
  body('role')
    .isIn(VALID_ROLES).withMessage('rôle invalide'),
  body('entreprise_id')
    .isUUID().withMessage('entreprise_id doit être un UUID'),
  body('service')
    .optional({ nullable: true })
    .isString()
    .isLength({ max: 255 }),
  body('date_embauche')
    .optional({ nullable: true, values: 'falsy' })
    .matches(DATE_REGEX).withMessage('date_embauche doit être au format YYYY-MM-DD'),
];

/**
 * Règles de mise à jour d'un utilisateur (PUT /:id)
 * Tous les champs sont optionnels — on valide les types si présents
 */
const updateUserRules = [
  body('nom')
    .optional({ nullable: true })
    .isString()
    .isLength({ max: 255 }),
  body('prenom')
    .optional({ nullable: true })
    .isString()
    .isLength({ max: 255 }),
  body('email')
    .optional({ nullable: true })
    .isString()
    .isLength({ max: 255 }),
  body('role')
    .optional({ nullable: true })
    .isIn(VALID_ROLES).withMessage('rôle invalide'),
  body('statut')
    .optional({ nullable: true })
    .isIn(VALID_STATUTS).withMessage('statut invalide'),
  body('service')
    .optional({ nullable: true })
    .isString()
    .isLength({ max: 255 }),
  body('date_embauche')
    .optional({ nullable: true, values: 'falsy' })
    .matches(DATE_REGEX).withMessage('date_embauche doit être au format YYYY-MM-DD'),
  // password en clair (uniquement admin)
  body('password')
    .optional()
    .isString()
    .isLength({ max: 300 }),
];

/**
 * Changement de rôle (PUT /:id/role)
 */
const changeRoleRules = [
  body('role')
    .isIn(VALID_ROLES).withMessage('rôle invalide'),
];

module.exports = { createUserRules, updateUserRules, changeRoleRules };
