const ExportService = require('../services/exportService');
const { Entreprise } = require('../models');

async function resolveEntrepriseId(req) {
  if (req.user?.role === 'super_admin') {
    return req.query?.entrepriseId || null;
  }
  if (req.user?.entreprise_id) {
    return req.user.entreprise_id;
  }
  return null;
}

function handleExportError(res, err) {
  console.error('Erreur export:', err);
  res.status(500).json({ error: err.message || 'Erreur lors de la génération de l\'export' });
}

class ExportController {
  // =========================
  // STATISTIQUES
  // =========================
  static async exportStatistiquesCSV(req, res) {
    try {
      const entrepriseId = await resolveEntrepriseId(req);
      const data = await ExportService.generateStatistiquesCSV(entrepriseId, req.query);
      res.setHeader('Content-Type', 'text/csv');
      res.send(data);
    } catch (err) { handleExportError(res, err); }
  }

  // =========================
  // PREVIEW
  // =========================
  static async previewExport(req, res) {
    try {
      const entrepriseId = await resolveEntrepriseId(req);
      const type = req.query.type || 'conges';
      const preview = await ExportService.getPreview(type, entrepriseId, req.query, req.query.limit);
      res.json({ type, ...preview });
    } catch (err) { handleExportError(res, err); }
  }

  // =========================
  // CONGÉS
  // =========================
  static async exportCongesCSV(req, res) {
    try {
      const entrepriseId = await resolveEntrepriseId(req);
      const data = await ExportService.generateCongesCSV(entrepriseId, req.query, req.user.role);
      res.setHeader('Content-Type', 'text/csv');
      res.send(data);
    } catch (err) { handleExportError(res, err); }
  }

  static async exportCongesPDF(req, res) {
    try {
      const entrepriseId = await resolveEntrepriseId(req);
      let entrepriseName = null;
      if (req.user?.entreprise_id) {
        const ent = await Entreprise.findByPk(req.user.entreprise_id);
        entrepriseName = ent?.nom || null;
      }
      const data = await ExportService.generateCongesPDF(entrepriseId, req.query, entrepriseName);
      res.setHeader('Content-Type', 'application/pdf');
      res.send(data);
    } catch (err) { handleExportError(res, err); }
  }

  // =========================
  // ABSENCES
  // =========================
  static async exportAbsencesCSV(req, res) {
    try {
      const entrepriseId = await resolveEntrepriseId(req);
      const data = await ExportService.generateAbsencesCSV(entrepriseId, req.query);
      res.setHeader('Content-Type', 'text/csv');
      res.send(data);
    } catch (err) { handleExportError(res, err); }
  }

  static async exportAbsencesPDF(req, res) {
    try {
      const entrepriseId = await resolveEntrepriseId(req);
      let entrepriseName = null;
      if (req.user?.entreprise_id) {
        const ent = await Entreprise.findByPk(req.user.entreprise_id);
        entrepriseName = ent?.nom || null;
      }
      const data = await ExportService.generateAbsencesPDF(entrepriseId, req.query, entrepriseName);
      res.setHeader('Content-Type', 'application/pdf');
      res.send(data);
    } catch (err) { handleExportError(res, err); }
  }

  // =========================
  // ARRÊTS MALADIE
  // =========================
  static async exportArretsMaladieCSV(req, res) {
    try {
      const entrepriseId = await resolveEntrepriseId(req);
      const data = await ExportService.generateArretsMaladieCSV(entrepriseId, req.query);
      res.setHeader('Content-Type', 'text/csv');
      res.send(data);
    } catch (err) { handleExportError(res, err); }
  }

  static async exportArretsMaladiePDF(req, res) {
    try {
      const entrepriseId = await resolveEntrepriseId(req);
      let entrepriseName = null;
      if (req.user?.entreprise_id) {
        const ent = await Entreprise.findByPk(req.user.entreprise_id);
        entrepriseName = ent?.nom || null;
      }
      const data = await ExportService.generateArretsMaladiePDF(entrepriseId, req.query, entrepriseName);
      res.setHeader('Content-Type', 'application/pdf');
      res.send(data);
    } catch (err) { handleExportError(res, err); }
  }

  // =========================
  // UTILISATEURS
  // =========================
  static async exportUtilisateursCSV(req, res) {
    try {
      const entrepriseId = await resolveEntrepriseId(req);
      const data = await ExportService.generateUtilisateursCSV(entrepriseId);
      res.setHeader('Content-Type', 'text/csv');
      res.send(data);
    } catch (err) { handleExportError(res, err); }
  }

  // =========================
  // ENTREPRISES
  // =========================
  static async exportEntreprisesCSV(req, res) {
    try {
      const data = await ExportService.generateEntreprisesCSV();
      res.setHeader('Content-Type', 'text/csv');
      res.send(data);
    } catch (err) { handleExportError(res, err); }
  }

  // =========================
  // AUDIT
  // =========================
  static async exportAuditCSV(req, res) {
    try {
      const entrepriseId = await resolveEntrepriseId(req);
      const data = await ExportService.generateAuditLogsCSV(entrepriseId, req.query);
      res.setHeader('Content-Type', 'text/csv');
      res.send(data);
    } catch (err) { handleExportError(res, err); }
  }

  // =========================
  // USAGE
  // =========================
  static async exportUsagePDF(req, res) {
    try {
      const entrepriseId = await resolveEntrepriseId(req);
      const data = await ExportService.generateUsageReportPDF(entrepriseId);
      res.setHeader('Content-Type', 'application/pdf');
      res.send(data);
    } catch (err) { handleExportError(res, err); }
  }
}

module.exports = ExportController;
