const express = require('express');
const router = express.Router();
const authJwt = require('../middlewares/authJwt');
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

router.post('/init', authJwt, authorizeRole(['admin_entreprise', 'super_admin']), initQuota);
router.get('/solde/:utilisateur_id/:conge_type_id', authJwt, authorizeRole(['employe', 'manager', 'admin_entreprise', 'super_admin']), getSolde);
router.get('/soldes/:utilisateur_id', authJwt, authorizeRole(['employe', 'manager', 'admin_entreprise', 'super_admin']), getSoldes);
router.get('/usage', authJwt, authorizeRole(['admin_entreprise', 'super_admin']), getUsageReport);
router.get('/counters/:utilisateur_id', authJwt, authorizeRole(['admin_entreprise', 'super_admin']), getUserCounters);
router.post('/counters/:utilisateur_id', authJwt, authorizeRole(['admin_entreprise', 'super_admin']), upsertUserCounter);
router.delete('/counters/:counter_id', authJwt, authorizeRole(['admin_entreprise', 'super_admin']), removeUserCounter);
router.post('/monthly-accrual', authJwt, authorizeRole(['admin_entreprise', 'super_admin']), monthlyAccrual);
router.post('/recalculate-prorata', authJwt, authorizeRole(['admin_entreprise', 'super_admin']), recalculateProrata);

module.exports = router;