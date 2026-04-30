'use strict';
const { body } = require('express-validator');

// Longueur max raisonnable pour éviter les payloads volumineux
const MAX_STR = 300;

/**
 * Login — email + password présents et non vides
 */
const loginRules = [
  body('email')
    .isEmail().withMessage('email invalide')
    .trim().toLowerCase(),
  body('password')
    .isString().withMessage('password requis')
    .notEmpty().withMessage('password requis')
    .isLength({ max: MAX_STR }),
];

/**
 * Register — champs minimaux pour que le service fonctionne
 * Les validations métier restent dans authService.registerEntreprise
 */
const registerRules = [
  body('email')
    .isEmail().withMessage('email invalide')
    .trim().toLowerCase(),
  body('password')
    .isString().notEmpty()
    .isLength({ max: MAX_STR }),
  // Nom entreprise (champ le plus courant dans les payloads register)
  body('nom')
    .optional({ nullable: true })
    .isString()
    .isLength({ max: 255 }),
  body('prenom')
    .optional({ nullable: true })
    .isString()
    .isLength({ max: 255 }),
];

/**
 * Forgot password — juste un email
 */
const forgotPasswordRules = [
  body('email')
    .isEmail().withMessage('email invalide')
    .trim().toLowerCase(),
];

/**
 * Reset password — token + nouveau mot de passe
 */
const resetPasswordRules = [
  body('token')
    .isString().notEmpty(),
  body('newPassword')
    .isString().notEmpty()
    .isLength({ max: MAX_STR }),
];

/**
 * Change password (utilisateur connecté)
 */
const changePasswordRules = [
  body('currentPassword')
    .isString().notEmpty()
    .isLength({ max: MAX_STR }),
  body('newPassword')
    .isString().notEmpty()
    .isLength({ max: MAX_STR }),
];

module.exports = {
  loginRules,
  registerRules,
  forgotPasswordRules,
  resetPasswordRules,
  changePasswordRules,
};
