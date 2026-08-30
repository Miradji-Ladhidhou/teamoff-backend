const express = require('express');
const router = express.Router();
const multer = require('multer');
const authorizeRole = require('../middlewares/authorizeRole');
const validateUUIDParam = require('../middlewares/validateUUIDParam');
const { checkUsageLimit } = require('../middlewares/usageLimiter');
const { advancedRateLimiter } = require('../middlewares/advancedRateLimiter');
const congeController = require('../controllers/congeController');
const { importCongesCSV, getCongesImportTemplate } = require('../controllers/congesImportController');
const actionRequestController = require('../controllers/congeActionRequestController');
const { AuditLog, Conge, Utilisateur } = require('../models');
const validate = require('../middlewares/validate');
const { createCongeRules, updateCongeRules, checkOverlapRules, rejectCongeRules } = require('../validators/conges.validators');

const csvUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

// Import CSV — avant /:id pour éviter les conflits de route
router.get('/import/csv/template', authorizeRole(['super_admin']), getCongesImportTemplate);
router.post('/import/csv', authorizeRole(['super_admin']), csvUpload.single('file'), importCongesCSV);

router.post('/check-overlap', authorizeRole(['employe','apprenti','manager','super_admin']), advancedRateLimiter('conges'), validate(checkOverlapRules), congeController.checkOverlap);
router.post('/calculate-days', authorizeRole(['employe','apprenti','manager','admin_entreprise','super_admin']), advancedRateLimiter('conges'), congeController.calculateDays);
router.post('/demande', authorizeRole(['employe','apprenti','manager','super_admin']), advancedRateLimiter('conges'), checkUsageLimit('create_conge'), validate(createCongeRules), congeController.create);
router.get('/', authorizeRole(['employe','apprenti','manager','admin_entreprise','super_admin']), congeController.list);

// Demandes de modification/annulation — avant /:id pour éviter les conflits de route
// manager autorisé : l'approbation/refus vérifie le workflow figé en amont dans le service
router.get('/action-requests', authorizeRole(['manager','admin_entreprise','super_admin']), actionRequestController.list);
router.get('/action-requests/:requestId', authorizeRole(['manager','admin_entreprise','super_admin']), validateUUIDParam('requestId'), actionRequestController.getOne);
router.post('/action-requests/:requestId/approve', authorizeRole(['manager','admin_entreprise','super_admin']), validateUUIDParam('requestId'), advancedRateLimiter('conges'), actionRequestController.approve);
router.post('/action-requests/:requestId/reject', authorizeRole(['manager','admin_entreprise','super_admin']), validateUUIDParam('requestId'), advancedRateLimiter('conges'), actionRequestController.reject);

router.get('/:id', authorizeRole(['employe','apprenti','manager','admin_entreprise','super_admin']), validateUUIDParam('id'), congeController.get);
router.put('/:id', authorizeRole(['employe','apprenti','manager','admin_entreprise','super_admin']), validateUUIDParam('id'), advancedRateLimiter('conges'), validate(updateCongeRules), congeController.update);
router.delete('/:id', authorizeRole(['employe','apprenti','manager','admin_entreprise','super_admin']), validateUUIDParam('id'), advancedRateLimiter('conges'), congeController.remove);
router.get('/:id/validation-overlap', authorizeRole(['manager','admin_entreprise','super_admin']), validateUUIDParam('id'), congeController.checkValidationOverlap);
router.get('/:id/history', authorizeRole(['employe','apprenti','manager','admin_entreprise','super_admin']), validateUUIDParam('id'), async (req, res, next) => {
  try {
    if (['employe', 'apprenti'].includes(req.user.role)) {
      const conge = await Conge.findOne({ where: { id: req.params.id, utilisateur_id: req.user.id } });
      if (!conge) return res.status(403).json({ message: 'Accès interdit' });
    } else if (req.user.role !== 'super_admin') {
      const conge = await Conge.findOne({ where: { id: req.params.id, entreprise_id: req.user.entreprise_id } });
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
router.get('/:id/attestation', authorizeRole(['employe','apprenti','manager','admin_entreprise','super_admin']), validateUUIDParam('id'), congeController.getAttestationData);
router.post('/:id/attestation/email', authorizeRole(['employe','apprenti','manager','admin_entreprise','super_admin']), validateUUIDParam('id'), advancedRateLimiter('conges'), congeController.sendAttestationEmail);
router.post('/:id/validate', authorizeRole(['manager','admin_entreprise','super_admin']), validateUUIDParam('id'), advancedRateLimiter('conges'), congeController.validate);
router.post('/:id/reject', authorizeRole(['manager','admin_entreprise','super_admin']), validateUUIDParam('id'), advancedRateLimiter('conges'), validate(rejectCongeRules), congeController.reject);
router.post('/:id/activate', authorizeRole(['manager','admin_entreprise','super_admin']), validateUUIDParam('id'), advancedRateLimiter('conges'), congeController.activate);

// Demande de modification/annulation depuis la fiche congé (employé)
router.post('/:id/action-request', authorizeRole(['employe','apprenti','manager']), validateUUIDParam('id'), advancedRateLimiter('conges'), actionRequestController.submit);

module.exports = router;
