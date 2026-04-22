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
router.post('/refresh', authController.refresh);
router.post('/logout', authController.logout);

module.exports = router;