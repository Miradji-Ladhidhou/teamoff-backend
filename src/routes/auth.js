const express = require('express');
const router = express.Router();
const { advancedRateLimiter } = require('../middlewares/advancedRateLimiter');
const authController = require('../controllers/authController');
const authJwt = require('../middlewares/authJwt');
const validate = require('../middlewares/validate');
const {
  loginRules,
  registerRules,
  forgotPasswordRules,
  resetPasswordRules,
  changePasswordRules,
} = require('../validators/auth.validators');

router.post('/register', advancedRateLimiter('register'), validate(registerRules), authController.register);
router.post('/login', advancedRateLimiter('login'), validate(loginRules), authController.login);
router.post('/forgot-password', advancedRateLimiter('forgotPassword'), validate(forgotPasswordRules), authController.forgotPassword);
router.post('/reset-password', advancedRateLimiter('forgotPassword'), validate(resetPasswordRules), authController.resetPassword);
router.post('/change-password', authJwt, advancedRateLimiter('login'), validate(changePasswordRules), authController.changePassword);
router.post('/refresh', advancedRateLimiter('refresh'), authController.refresh);
router.post('/logout', authController.logout);

module.exports = router;