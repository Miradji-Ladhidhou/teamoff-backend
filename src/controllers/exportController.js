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
  res.setHeader('Content-Type', 'text/csv; charset=utf-16le');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  // UTF-16 LE BOM (FF FE) : encodage natif Excel Windows, reconnu par toutes les versions
  // sans ambiguïté, contrairement à l'UTF-8 BOM que certains Excel ignorent.
  const bom = Buffer.from([0xFF, 0xFE]);
  const content = Buffer.from(data, 'utf16le');
  res.send(Buffer.concat([bom, content]));
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
      const role = req.user.role;

      // Droits miroirs des routes CSV/PDF : les types sensibles exigent admin_entreprise+.
      // Un manager ne doit pas contourner adminOrSuper via /preview.
      const ADMIN_ONLY_TYPES = new Set(['audit', 'utilisateurs', 'usage', 'statistiques']);
      const ALL_TYPES = new Set(['conges', 'absences', 'arrets_maladie', 'tout', 'audit', 'utilisateurs', 'usage', 'statistiques']);

      if (!ALL_TYPES.has(type)) {
        return res.status(400).json({ message: `Type de preview non supporté : ${type}` });
      }

      const isAdminOrSuper = role === 'admin_entreprise' || role === 'super_admin';
      if (ADMIN_ONLY_TYPES.has(type) && !isAdminOrSuper) {
        return res.status(403).json({ message: 'Accès refusé : ce type de preview requiert le rôle admin_entreprise ou super_admin.' });
      }

      // Fix #52 : borner limit pour éviter un LIMIT 999999 en base (DoS).
      const rawLimit = parseInt(req.query.limit, 10);
      const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 500) : 50;
      const preview = await ExportService.getPreview(type, entrepriseId, req.query, limit, role);
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
      const data = await ExportService.generateCongesPDF(entrepriseId, req.query, entrepriseName, req.user.role);
      sendPDF(res, data, 'conges.pdf');
    } catch (err) { handleExportError(next, err); }
  }

  // =========================
  // ABSENCES
  // =========================
  static async exportAbsencesCSV(req, res, next) {
    try {
      const entrepriseId = await resolveEntrepriseId(req);
      const data = await ExportService.generateAbsencesCSV(entrepriseId, req.query, req.user.role);
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
      const data = await ExportService.generateAbsencesPDF(entrepriseId, req.query, entrepriseName, req.user.role);
      sendPDF(res, data, 'absences.pdf');
    } catch (err) { handleExportError(next, err); }
  }

  // =========================
  // ARRÊTS MALADIE
  // =========================
  static async exportArretsMaladieCSV(req, res, next) {
    try {
      const entrepriseId = await resolveEntrepriseId(req);
      const data = await ExportService.generateArretsMaladieCSV(entrepriseId, req.query, req.user.role);
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
      const data = await ExportService.generateArretsMaladiePDF(entrepriseId, req.query, entrepriseName, req.user.role);
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
  // TOUT (congés + absences + arrêts maladie)
  // =========================
  static async exportToutCSV(req, res, next) {
    try {
      const entrepriseId = await resolveEntrepriseId(req);
      const data = await ExportService.generateToutCSV(entrepriseId, req.query, req.user?.role);
      sendCSV(res, data, 'absences-conges.csv');
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
