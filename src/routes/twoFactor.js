const express = require('express');
const router = express.Router();
const authJwt = require('../middlewares/authJwt');
const { advancedRateLimiter } = require('../middlewares/advancedRateLimiter');
const { setup2FA, enable2FA, disable2FA, verify2FA } = require('../controllers/twoFactorController');

router.get('/setup', authJwt, setup2FA);
router.post('/enable', authJwt, enable2FA);
router.post('/disable', authJwt, disable2FA);
router.post('/verify', advancedRateLimiter('login'), verify2FA);

module.exports = router;
