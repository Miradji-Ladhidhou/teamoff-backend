const express = require('express');
const router = express.Router();
const authJwt = require('../middlewares/authJwt');
const authorizeRole = require('../middlewares/authorizeRole');
const { checkUsageLimit } = require('../middlewares/usageLimiter');
const congeController = require('../controllers/congeController');

router.post('/demande', authJwt, authorizeRole(['employe','manager','admin_entreprise','super_admin']), checkUsageLimit('create_conge'), congeController.create);
router.get('/', authJwt, authorizeRole(['employe','manager','admin_entreprise','super_admin']), congeController.list);
router.get('/:id', authJwt, authorizeRole(['employe','manager','admin_entreprise','super_admin']), congeController.get);
router.put('/:id', authJwt, authorizeRole(['employe','manager','admin_entreprise','super_admin']), congeController.update);
router.delete('/:id', authJwt, authorizeRole(['employe','manager','admin_entreprise','super_admin']), congeController.remove);
router.post('/:id/validate', authJwt, authorizeRole(['manager','admin_entreprise','super_admin']), congeController.validate);
router.post('/:id/reject', authJwt, authorizeRole(['manager','admin_entreprise','super_admin']), congeController.reject);

module.exports = router;