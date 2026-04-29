'use strict';
/**
 * validate.js — factory de validation express-validator.
 *
 * Usage :
 *   const validate = require('../middlewares/validate');
 *   const { loginRules } = require('../validators/auth.validators');
 *   router.post('/login', validate(loginRules), authController.login);
 *
 * En cas d'erreur → 422 { message: 'Données invalides' }
 * Sans détail — on ne fuite pas les contraintes internes.
 */
const { validationResult } = require('express-validator');

function validate(rules) {
  return [
    ...rules,
    (req, res, next) => {
      const result = validationResult(req);
      if (!result.isEmpty()) {
        return res.status(422).json({ message: 'Données invalides' });
      }
      next();
    },
  ];
}

module.exports = validate;
