const express = require('express');
const router = express.Router();
const authJwt = require('../middlewares/authJwt');
const authorizeRole = require('../middlewares/authorizeRole');
const { advancedRateLimiter } = require('../middlewares/advancedRateLimiter');
const { setup2FA, enable2FA, disable2FA, verify2FA, adminDisable2FA } = require('../controllers/twoFactorController');

router.get('/setup', authJwt, setup2FA);
router.post('/enable', authJwt, advancedRateLimiter('login'), enable2FA);
router.post('/disable', authJwt, advancedRateLimiter('login'), disable2FA);
router.post('/verify', advancedRateLimiter('login'), verify2FA);
router.post('/admin-disable/:userId', authJwt, authorizeRole(['super_admin']), adminDisable2FA);

module.exports = router;
