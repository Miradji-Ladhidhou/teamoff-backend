const express = require('express');
const router = express.Router();
const ExportController = require('../controllers/exportController');

// -----------------------------
// PREVIEW
// -----------------------------
router.get('/preview', ExportController.previewExport);

// -----------------------------
// CONGES
// -----------------------------
router.get('/conges/csv', ExportController.exportCongesCSV);
router.get('/conges/pdf', ExportController.exportCongesPDF);

// -----------------------------
// ABSENCES
// -----------------------------
router.get('/absences/csv', ExportController.exportAbsencesCSV);
router.get('/absences/pdf', ExportController.exportAbsencesPDF);

// -----------------------------
// ARRETS MALADIE
// -----------------------------
router.get('/arrets-maladie/csv', ExportController.exportArretsMaladieCSV);
router.get('/arrets-maladie/pdf', ExportController.exportArretsMaladiePDF);

// -----------------------------
// UTILISATEURS
// -----------------------------
router.get('/utilisateurs/csv', ExportController.exportUtilisateursCSV);

// -----------------------------
// AUDIT
// -----------------------------
router.get('/audit/csv', ExportController.exportAuditCSV);

// -----------------------------
// USAGE / STATS
// -----------------------------
router.get('/usage/pdf', ExportController.exportUsagePDF);
router.get('/statistiques/csv', ExportController.exportStatistiquesCSV);

// -----------------------------
// ENTREPRISES
// -----------------------------

module.exports = router;