const express = require('express');
const router = express.Router();
const authJwt = require('../middlewares/authJwt');
const authorizeRole = require('../middlewares/authorizeRole');
const ExportController = require('../controllers/exportController');

// Routes d'export pour les administrateurs d'entreprise et super admin
router.get('/conges/csv', authJwt, authorizeRole(['admin_entreprise', 'super_admin']), ExportController.exportCongesCSV);
router.get('/conges/pdf', authJwt, authorizeRole(['admin_entreprise', 'super_admin']), ExportController.exportCongesPDF);
router.get('/utilisateurs/csv', authJwt, authorizeRole(['admin_entreprise', 'super_admin']), ExportController.exportUtilisateursCSV);
router.get('/audit/csv', authJwt, authorizeRole(['admin_entreprise', 'super_admin']), ExportController.exportAuditLogsCSV);
router.get('/usage/pdf', authJwt, authorizeRole(['admin_entreprise', 'super_admin']), ExportController.exportUsageReportPDF);

module.exports = router;