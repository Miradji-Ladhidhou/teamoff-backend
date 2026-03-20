const express = require('express');
const router = express.Router();
const authJwt = require('../middlewares/authJwt');
const authorizeRole = require('../middlewares/authorizeRole');
const ExportController = require('../controllers/exportController');

// Les managers peuvent exporter uniquement les congés de leur entreprise.
router.get('/preview', authJwt, authorizeRole(['manager', 'admin_entreprise', 'super_admin']), ExportController.previewExport);
router.get('/conges/csv', authJwt, authorizeRole(['manager', 'admin_entreprise', 'super_admin']), ExportController.exportCongesCSV);
router.get('/conges/pdf', authJwt, authorizeRole(['manager', 'admin_entreprise', 'super_admin']), ExportController.exportCongesPDF);
router.get('/utilisateurs/csv', authJwt, authorizeRole(['admin_entreprise', 'super_admin']), ExportController.exportUtilisateursCSV);
router.get('/entreprises/csv', authJwt, authorizeRole(['super_admin']), ExportController.exportEntreprisesCSV);
router.get('/audit/csv', authJwt, authorizeRole(['admin_entreprise', 'super_admin']), ExportController.exportAuditLogsCSV);
router.get('/usage/pdf', authJwt, authorizeRole(['admin_entreprise', 'super_admin']), ExportController.exportUsageReportPDF);

module.exports = router;