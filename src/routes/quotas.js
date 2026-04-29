const express = require('express');
const router = express.Router();
const authorizeRole = require('../middlewares/authorizeRole');
const {
	initQuota,
	getSolde,
	getSoldes,
	getUsageReport,
	getUserCounters,
	upsertUserCounter,
	removeUserCounter,
	recalculateProrata,
	monthlyAccrual,
} = require('../controllers/quotasController');
const validateUUIDParam = require('../middlewares/validateUUIDParam');

router.post('/init', authorizeRole(['admin_entreprise', 'super_admin']), initQuota);
router.get('/solde/:utilisateur_id/:conge_type_id', authorizeRole(['employe', 'manager', 'admin_entreprise', 'super_admin']), validateUUIDParam('utilisateur_id'), validateUUIDParam('conge_type_id'), getSolde);
router.get('/soldes/:utilisateur_id', authorizeRole(['employe', 'manager', 'admin_entreprise', 'super_admin']), validateUUIDParam('utilisateur_id'), getSoldes);
router.get('/usage', authorizeRole(['admin_entreprise', 'super_admin']), getUsageReport);
router.get('/counters/:utilisateur_id', authorizeRole(['admin_entreprise', 'super_admin']), validateUUIDParam('utilisateur_id'), getUserCounters);
router.post('/counters/:utilisateur_id', authorizeRole(['admin_entreprise', 'super_admin']), validateUUIDParam('utilisateur_id'), upsertUserCounter);
router.delete('/counters/:counter_id', authorizeRole(['admin_entreprise', 'super_admin']), validateUUIDParam('counter_id'), removeUserCounter);
router.post('/monthly-accrual', authorizeRole(['admin_entreprise', 'super_admin']), monthlyAccrual);
router.post('/recalculate-prorata', authorizeRole(['admin_entreprise', 'super_admin']), recalculateProrata);

module.exports = router;