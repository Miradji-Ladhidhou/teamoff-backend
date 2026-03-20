const express = require('express');
const router = express.Router();
const { advancedRateLimiter } = require('../middlewares/advancedRateLimiter');
const authController = require('../controllers/authController');
const authJwt = require('../middlewares/authJwt');

// -------------------------------
// Rate limiter pour le login
// -------------------------------


// -------------------------------
// Routes auth
// -------------------------------

// Auth endpoints avec rate limiting avancé
router.post('/register', authController.register);
router.post('/login', advancedRateLimiter('login'), authController.login);
router.post('/forgot-password', advancedRateLimiter('forgotPassword'), authController.forgotPassword);
router.post('/reset-password', advancedRateLimiter('forgotPassword'), authController.resetPassword);
router.post('/change-password', authJwt, advancedRateLimiter('login'), authController.changePassword);
router.post('/logout', authController.logout);
// Les routes suivantes sont accessibles sans rate limit strict (ou protégées ailleurs)
router.post('/forgot-password', authController.forgotPassword);
router.post('/reset-password', authController.resetPassword);
router.post('/change-password', authJwt, authController.changePassword);

module.exports = router;