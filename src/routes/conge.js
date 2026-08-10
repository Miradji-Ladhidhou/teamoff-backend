const express = require('express');
const router = express.Router();
const multer = require('multer');
const authorizeRole = require('../middlewares/authorizeRole');
const validateUUIDParam = require('../middlewares/validateUUIDParam');
const { checkUsageLimit } = require('../middlewares/usageLimiter');
const { advancedRateLimiter } = require('../middlewares/advancedRateLimiter');
const congeController = require('../controllers/congeController');
const { importCongesCSV, getCongesImportTemplate } = require('../controllers/congesImportController');
const { AuditLog, Conge, Utilisateur } = require('../models');
const validate = require('../middlewares/validate');
const { createCongeRules, updateCongeRules, checkOverlapRules, rejectCongeRules } = require('../validators/conges.validators');

const csvUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

// Import CSV — avant /:id pour éviter les conflits de route
router.get('/import/csv/template', authorizeRole(['super_admin']), getCongesImportTemplate);
router.post('/import/csv', authorizeRole(['super_admin']), csvUpload.single('file'), importCongesCSV);

router.post('/check-overlap', authorizeRole(['employe','manager']), advancedRateLimiter('conges'), validate(checkOverlapRules), congeController.checkOverlap);
router.post('/calculate-days', authorizeRole(['employe','manager','admin_entreprise','super_admin']), advancedRateLimiter('conges'), congeController.calculateDays);
router.get('/:id/validation-overlap', authorizeRole(['manager','admin_entreprise','super_admin']), validateUUIDParam('id'), congeController.checkValidationOverlap);
router.post('/demande', authorizeRole(['employe','manager']), advancedRateLimiter('conges'), checkUsageLimit('create_conge'), validate(createCongeRules), congeController.create);
router.get('/', authorizeRole(['employe','manager','admin_entreprise','super_admin']), congeController.list);
router.get('/:id', authorizeRole(['employe','manager','admin_entreprise','super_admin']), validateUUIDParam('id'), congeController.get);
router.put('/:id', authorizeRole(['employe','manager','admin_entreprise','super_admin']), validateUUIDParam('id'), advancedRateLimiter('conges'), validate(updateCongeRules), congeController.update);
router.delete('/:id', authorizeRole(['employe','manager','admin_entreprise','super_admin']), validateUUIDParam('id'), advancedRateLimiter('conges'), congeController.remove);
router.get('/:id/history', authorizeRole(['employe','manager','admin_entreprise','super_admin']), validateUUIDParam('id'), async (req, res, next) => {
  try {
    if (req.user.role === 'employe') {
      const conge = await Conge.findOne({ where: { id: req.params.id, utilisateur_id: req.user.id } });
      if (!conge) return res.status(403).json({ message: 'Accès interdit' });
    }
    const logs = await AuditLog.findAll({
      where: { entity: 'Conge', entity_id: req.params.id },
      include: [{ model: Utilisateur, as: 'utilisateur', attributes: ['id', 'prenom', 'nom', 'role'], required: false }],
      order: [['created_at', 'ASC']],
    });
    res.json(logs);
  } catch (err) {
    next(err);
  }
});
router.get('/:id/attestation', authorizeRole(['employe','manager','admin_entreprise','super_admin']), validateUUIDParam('id'), congeController.getAttestationData);
router.post('/:id/attestation/email', authorizeRole(['employe','manager','admin_entreprise','super_admin']), validateUUIDParam('id'), advancedRateLimiter('conges'), congeController.sendAttestationEmail);
router.post('/:id/validate', authorizeRole(['manager','admin_entreprise','super_admin']), validateUUIDParam('id'), advancedRateLimiter('conges'), congeController.validate);
router.post('/:id/reject', authorizeRole(['manager','admin_entreprise','super_admin']), validateUUIDParam('id'), advancedRateLimiter('conges'), validate(rejectCongeRules), congeController.reject);
router.post('/:id/activate', authorizeRole(['manager','admin_entreprise','super_admin']), validateUUIDParam('id'), advancedRateLimiter('conges'), congeController.activate);

module.exports = router;
