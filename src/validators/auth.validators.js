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
  body('entreprise_nom').isString().notEmpty().withMessage('Nom entreprise requis').isLength({ max: 255 }),
  body('entreprise_email').isEmail().withMessage('Email entreprise invalide').trim().toLowerCase(),
  body('entreprise_telephone').isString().notEmpty().withMessage('Téléphone requis').isLength({ max: 50 }),
  body('admin_email').isEmail().withMessage('Email admin invalide').trim().toLowerCase(),
  body('admin_password').isString().notEmpty().isLength({ max: MAX_STR }),
  body('admin_nom').optional({ nullable: true }).isString().isLength({ max: 255 }),
  body('admin_prenom').optional({ nullable: true }).isString().isLength({ max: 255 }),
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
