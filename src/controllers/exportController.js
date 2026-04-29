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

function handleExportError(next, err) {
  next(err);
}

function sendCSV(res, data, filename) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(data);
}

function sendPDF(res, data, filename) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(data);
}

class ExportController {
  // =========================
  // STATISTIQUES
  // =========================
  static async exportStatistiquesCSV(req, res, next) {
    try {
      const entrepriseId = await resolveEntrepriseId(req);
      const data = await ExportService.generateStatistiquesCSV(entrepriseId, req.query);
      sendCSV(res, data, 'statistiques.csv');
    } catch (err) { handleExportError(next, err); }
  }

  // =========================
  // PREVIEW
  // =========================
  static async previewExport(req, res, next) {
    try {
      const entrepriseId = await resolveEntrepriseId(req);
      const type = req.query.type || 'conges';
      const preview = await ExportService.getPreview(type, entrepriseId, req.query, req.query.limit);
      res.json({ type, ...preview });
    } catch (err) { handleExportError(next, err); }
  }

  // =========================
  // CONGÉS
  // =========================
  static async exportCongesCSV(req, res, next) {
    try {
      const entrepriseId = await resolveEntrepriseId(req);
      const data = await ExportService.generateCongesCSV(entrepriseId, req.query, req.user.role);
      sendCSV(res, data, 'conges.csv');
    } catch (err) { handleExportError(next, err); }
  }

  static async exportCongesPDF(req, res, next) {
    try {
      const entrepriseId = await resolveEntrepriseId(req);
      let entrepriseName = null;
      if (req.user?.entreprise_id) {
        const ent = await Entreprise.findByPk(req.user.entreprise_id);
        entrepriseName = ent?.nom || null;
      }
      const data = await ExportService.generateCongesPDF(entrepriseId, req.query, entrepriseName);
      sendPDF(res, data, 'conges.pdf');
    } catch (err) { handleExportError(next, err); }
  }

  // =========================
  // ABSENCES
  // =========================
  static async exportAbsencesCSV(req, res, next) {
    try {
      const entrepriseId = await resolveEntrepriseId(req);
      const data = await ExportService.generateAbsencesCSV(entrepriseId, req.query);
      sendCSV(res, data, 'absences.csv');
    } catch (err) { handleExportError(next, err); }
  }

  static async exportAbsencesPDF(req, res, next) {
    try {
      const entrepriseId = await resolveEntrepriseId(req);
      let entrepriseName = null;
      if (req.user?.entreprise_id) {
        const ent = await Entreprise.findByPk(req.user.entreprise_id);
        entrepriseName = ent?.nom || null;
      }
      const data = await ExportService.generateAbsencesPDF(entrepriseId, req.query, entrepriseName);
      sendPDF(res, data, 'absences.pdf');
    } catch (err) { handleExportError(next, err); }
  }

  // =========================
  // ARRÊTS MALADIE
  // =========================
  static async exportArretsMaladieCSV(req, res, next) {
    try {
      const entrepriseId = await resolveEntrepriseId(req);
      const data = await ExportService.generateArretsMaladieCSV(entrepriseId, req.query);
      sendCSV(res, data, 'arrets-maladie.csv');
    } catch (err) { handleExportError(next, err); }
  }

  static async exportArretsMaladiePDF(req, res, next) {
    try {
      const entrepriseId = await resolveEntrepriseId(req);
      let entrepriseName = null;
      if (req.user?.entreprise_id) {
        const ent = await Entreprise.findByPk(req.user.entreprise_id);
        entrepriseName = ent?.nom || null;
      }
      const data = await ExportService.generateArretsMaladiePDF(entrepriseId, req.query, entrepriseName);
      sendPDF(res, data, 'arrets-maladie.pdf');
    } catch (err) { handleExportError(next, err); }
  }

  // =========================
  // UTILISATEURS
  // =========================
  static async exportUtilisateursCSV(req, res, next) {
    try {
      const entrepriseId = await resolveEntrepriseId(req);
      const data = await ExportService.generateUtilisateursCSV(entrepriseId);
      sendCSV(res, data, 'utilisateurs.csv');
    } catch (err) { handleExportError(next, err); }
  }

  // =========================
  // ENTREPRISES
  // =========================
  static async exportEntreprisesCSV(req, res, next) {
    try {
      const data = await ExportService.generateEntreprisesCSV();
      sendCSV(res, data, 'entreprises.csv');
    } catch (err) { handleExportError(next, err); }
  }

  // =========================
  // AUDIT
  // =========================
  static async exportAuditCSV(req, res, next) {
    try {
      const entrepriseId = await resolveEntrepriseId(req);
      const data = await ExportService.generateAuditLogsCSV(entrepriseId, req.query);
      sendCSV(res, data, 'audit.csv');
    } catch (err) { handleExportError(next, err); }
  }

  // =========================
  // USAGE
  // =========================
  static async exportUsagePDF(req, res, next) {
    try {
      const entrepriseId = await resolveEntrepriseId(req);
      const data = await ExportService.generateUsageReportPDF(entrepriseId);
      sendPDF(res, data, 'usage.pdf');
    } catch (err) { handleExportError(next, err); }
  }
}

module.exports = ExportController;
