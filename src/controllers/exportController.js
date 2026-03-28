const ExportService = require('../services/exportService');
const { Entreprise } = require('../models');

async function resolveEntrepriseId(req) {
  if (req.user?.role === 'super_admin') {
    return req.query?.entrepriseId || null;
  }

  if (req.user?.entreprise_id) {
    return req.user.entreprise_id;
  }

  const entreprise = await Entreprise.findOne();
  return entreprise?.id;
}

class ExportController {

  // =========================
  // PREVIEW
  // =========================
  static async previewExport(req, res) {
    try {
      const entrepriseId = await resolveEntrepriseId(req);
      const type = req.query.type || 'conges';

      const preview = await ExportService.getPreview(type, entrepriseId, req.query, req.query.limit);

      res.json({ type, ...preview });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }

  // =========================
  // CONGÉS
  // =========================
  static async exportCongesCSV(req, res) {
    const entrepriseId = await resolveEntrepriseId(req);
    const data = await ExportService.generateCongesCSV(entrepriseId, req.query, req.user.role);

    res.setHeader('Content-Type', 'text/csv');
    res.send(data);
  }

  static async exportCongesPDF(req, res) {
    const entrepriseId = await resolveEntrepriseId(req);
    let entrepriseName = null;
    if (req.user?.entreprise_id && Entreprise) {
      const ent = await Entreprise.findByPk(req.user.entreprise_id);
      entrepriseName = ent?.nom || null;
    }
    const data = await ExportService.generateCongesPDF(entrepriseId, req.query, entrepriseName);
    res.setHeader('Content-Type', 'application/pdf');
    res.send(data);
  }

  // =========================
  // ABSENCES
  // =========================
  static async exportAbsencesCSV(req, res) {
    const entrepriseId = await resolveEntrepriseId(req);
    const data = await ExportService.generateAbsencesCSV(entrepriseId, req.query);

    res.setHeader('Content-Type', 'text/csv');
    res.send(data);
  }

  static async exportAbsencesPDF(req, res) {
    const entrepriseId = await resolveEntrepriseId(req);
    let entrepriseName = null;
    if (req.user?.entreprise_id && Entreprise) {
      const ent = await Entreprise.findByPk(req.user.entreprise_id);
      entrepriseName = ent?.nom || null;
    }
    const data = await ExportService.generateAbsencesPDF(entrepriseId, req.query, entrepriseName);
    res.setHeader('Content-Type', 'application/pdf');
    res.send(data);
  }

  // =========================
  // ARRÊTS MALADIE
  // =========================
  static async exportArretsMaladieCSV(req, res) {
    const entrepriseId = await resolveEntrepriseId(req);
    const data = await ExportService.generateArretsMaladieCSV(entrepriseId, req.query);

    res.setHeader('Content-Type', 'text/csv');
    res.send(data);
  }

  static async exportArretsMaladiePDF(req, res) {
    const entrepriseId = await resolveEntrepriseId(req);
    let entrepriseName = null;
    if (req.user?.entreprise_id && Entreprise) {
      const ent = await Entreprise.findByPk(req.user.entreprise_id);
      entrepriseName = ent?.nom || null;
    }
    const data = await ExportService.generateArretsMaladiePDF(entrepriseId, req.query, entrepriseName);
    res.setHeader('Content-Type', 'application/pdf');
    res.send(data);
  }

  // =========================
  // UTILISATEURS
  // =========================
  static async exportUtilisateursCSV(req, res) {
    const entrepriseId = await resolveEntrepriseId(req);
    const data = await ExportService.generateUtilisateursCSV(entrepriseId);

    res.setHeader('Content-Type', 'text/csv');
    res.send(data);
  }

  // =========================
  // AUDIT
  // =========================
  static async exportAuditCSV(req, res) {
    const entrepriseId = await resolveEntrepriseId(req);
    const data = await ExportService.generateAuditLogsCSV(entrepriseId, req.query);

    res.setHeader('Content-Type', 'text/csv');
    res.send(data);
  }

  // =========================
  // USAGE
  // =========================
  static async exportUsagePDF(req, res) {
    const entrepriseId = await resolveEntrepriseId(req);
    const data = await ExportService.generateUsageReportPDF(entrepriseId);

    res.setHeader('Content-Type', 'application/pdf');
    res.send(data);
  }
}

module.exports = ExportController;