const express = require('express');
const router = express.Router();
const authJwt = require('../middlewares/authJwt');
const authorizeRole = require('../middlewares/authorizeRole');
const { checkUsageLimit } = require('../middlewares/usageLimiter');
const { advancedRateLimiter } = require('../middlewares/advancedRateLimiter');
const congeController = require('../controllers/congeController');


// Limite modérée sur les actions de modification
router.post('/check-overlap', authJwt, authorizeRole(['employe','manager']), advancedRateLimiter('conges'), congeController.checkOverlap);
router.get('/:id/validation-overlap', authJwt, authorizeRole(['manager','admin_entreprise','super_admin']), congeController.checkValidationOverlap);
router.post('/demande', authJwt, authorizeRole(['employe','manager']), advancedRateLimiter('conges'), checkUsageLimit('create_conge'), congeController.create);
router.get('/', authJwt, authorizeRole(['employe','manager','admin_entreprise','super_admin']), congeController.list);
router.get('/:id', authJwt, authorizeRole(['employe','manager','admin_entreprise','super_admin']), congeController.get);
router.put('/:id', authJwt, authorizeRole(['employe','manager','admin_entreprise']), advancedRateLimiter('conges'), congeController.update);
router.delete('/:id', authJwt, authorizeRole(['employe','manager','admin_entreprise']), advancedRateLimiter('conges'), congeController.remove);
router.post('/:id/validate', authJwt, authorizeRole(['manager','admin_entreprise','super_admin']), advancedRateLimiter('conges'), congeController.validate);
router.post('/:id/reject', authJwt, authorizeRole(['manager','admin_entreprise','super_admin']), advancedRateLimiter('conges'), congeController.reject);

module.exports = router;