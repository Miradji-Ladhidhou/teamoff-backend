const express = require('express');
const router = express.Router();
const ExportController = require('../controllers/exportController');
const authorizeRole = require('../middlewares/authorizeRole');

const adminOrSuper = authorizeRole(['admin_entreprise', 'super_admin']);
const managerOrAbove = authorizeRole(['manager', 'admin_entreprise', 'super_admin']);
const superOnly = authorizeRole(['super_admin']);

// -----------------------------
// PREVIEW
// -----------------------------
router.get('/preview', adminOrSuper, ExportController.previewExport);

// -----------------------------
// CONGES
// -----------------------------
router.get('/conges/csv', managerOrAbove, ExportController.exportCongesCSV);
router.get('/conges/pdf', managerOrAbove, ExportController.exportCongesPDF);

// -----------------------------
// ABSENCES
// -----------------------------
router.get('/absences/csv', managerOrAbove, ExportController.exportAbsencesCSV);
router.get('/absences/pdf', managerOrAbove, ExportController.exportAbsencesPDF);

// -----------------------------
// ARRETS MALADIE
// -----------------------------
router.get('/arrets-maladie/csv', managerOrAbove, ExportController.exportArretsMaladieCSV);
router.get('/arrets-maladie/pdf', managerOrAbove, ExportController.exportArretsMaladiePDF);

// -----------------------------
// UTILISATEURS
// -----------------------------
router.get('/utilisateurs/csv', adminOrSuper, ExportController.exportUtilisateursCSV);

// -----------------------------
// AUDIT
// -----------------------------
router.get('/audit/csv', adminOrSuper, ExportController.exportAuditCSV);

// -----------------------------
// USAGE / STATS
// -----------------------------
router.get('/usage/pdf', adminOrSuper, ExportController.exportUsagePDF);
router.get('/statistiques/csv', adminOrSuper, ExportController.exportStatistiquesCSV);

// -----------------------------
// ENTREPRISES (super_admin only)
// -----------------------------
router.get('/entreprises/csv', superOnly, ExportController.exportEntreprisesCSV);

module.exports = router;
