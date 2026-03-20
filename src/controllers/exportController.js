const ExportService = require('../services/exportService');
const { Entreprise } = require('../models');

async function resolveEntrepriseId(req) {
  if (req.user?.role === 'super_admin') {
    return req.query?.entrepriseId || null;
  }

  if (req.user?.entreprise_id) {
    return req.user.entreprise_id;
  }

  if (req.query?.entrepriseId) {
    return req.query.entrepriseId;
  }

  const entreprise = await Entreprise.findOne({
    attributes: ['id'],
    order: [['createdAt', 'ASC']],
  });

  return entreprise?.id || null;
}

class ExportController {
  // Prévisualisation des données avant export
  static async previewExport(req, res) {
    try {
      const entrepriseId = await resolveEntrepriseId(req);
      if (!entrepriseId) {
        return res.status(400).json({ error: 'Aucune entreprise disponible pour la prévisualisation.' });
      }

      const type = req.query.type || 'conges';
      if (req.user?.role === 'manager' && type !== 'conges') {
        return res.status(403).json({ error: 'Les managers peuvent uniquement prévisualiser les congés.' });
      }
      const requestedLimit = Number(req.query.limit || 50);
      const limit = Number.isNaN(requestedLimit) ? 50 : Math.max(1, Math.min(200, requestedLimit));

      const preview = await ExportService.getPreview(type, entrepriseId, req.query, limit);

      return res.json({
        type,
        ...preview,
      });
    } catch (error) {
      console.error('Erreur lors de la prévisualisation export:', error);
      return res.status(500).json({ error: 'Erreur lors de la prévisualisation export' });
    }
  }

  // Export des congés en CSV
  static async exportCongesCSV(req, res) {
    try {
      const entrepriseId = await resolveEntrepriseId(req);
      if (!entrepriseId) {
        return res.status(400).json({ error: 'Aucune entreprise disponible pour l\'export.' });
      }
      const filters = req.query; // status, dateDebut, dateFin, utilisateurId

      const userRole = req.user?.role || 'admin_entreprise';
      const csvData = await ExportService.generateCongesCSV(entrepriseId, filters, userRole);

      const filename = `conges_${new Date().toISOString().split('T')[0]}.csv`;

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(csvData);
    } catch (error) {
      console.error('Erreur lors de l\'export CSV des congés:', error);
      res.status(500).json({ error: 'Erreur lors de l\'export CSV' });
    }
  }

  // Export des congés en PDF
  static async exportCongesPDF(req, res) {
    try {
      const entrepriseId = await resolveEntrepriseId(req);
      if (!entrepriseId) {
        return res.status(400).json({ error: 'Aucune entreprise disponible pour l\'export.' });
      }
      const filters = req.query; // status, dateDebut, dateFin

      const userRole = req.user?.role || 'admin_entreprise';
      const pdfData = await ExportService.generateCongesPDF(entrepriseId, filters, userRole);

      const filename = `conges_${new Date().toISOString().split('T')[0]}.pdf`;

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(pdfData);
    } catch (error) {
      console.error('Erreur lors de l\'export PDF des congés:', error);
      res.status(500).json({ error: 'Erreur lors de l\'export PDF' });
    }
  }

  // Export des utilisateurs en CSV
  static async exportUtilisateursCSV(req, res) {
    try {
      const entrepriseId = await resolveEntrepriseId(req);
      if (!entrepriseId) {
        return res.status(400).json({ error: 'Aucune entreprise disponible pour l\'export.' });
      }

      const csvData = await ExportService.generateUtilisateursCSV(entrepriseId);

      const filename = `utilisateurs_${new Date().toISOString().split('T')[0]}.csv`;

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(csvData);
    } catch (error) {
      console.error('Erreur lors de l\'export CSV des utilisateurs:', error);
      res.status(500).json({ error: 'Erreur lors de l\'export CSV' });
    }
  }

  // Export des logs d'audit en CSV
  static async exportAuditLogsCSV(req, res) {
    try {
      const entrepriseId = await resolveEntrepriseId(req);
      if (!entrepriseId) {
        return res.status(400).json({ error: 'Aucune entreprise disponible pour l\'export.' });
      }
      const filters = req.query; // dateDebut, dateFin, action, utilisateurId

      const csvData = await ExportService.generateAuditLogsCSV(entrepriseId, filters);

      const filename = `audit_logs_${new Date().toISOString().split('T')[0]}.csv`;

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(csvData);
    } catch (error) {
      console.error('Erreur lors de l\'export CSV des logs d\'audit:', error);
      res.status(500).json({ error: 'Erreur lors de l\'export CSV' });
    }
  }

  // Export du rapport d'usage en PDF
  static async exportUsageReportPDF(req, res) {
    try {
      const entrepriseId = await resolveEntrepriseId(req);
      if (!entrepriseId) {
        return res.status(400).json({ error: 'Aucune entreprise disponible pour l\'export.' });
      }

      const pdfData = await ExportService.generateUsageReportPDF(entrepriseId);

      const filename = `rapport_usage_${new Date().toISOString().split('T')[0]}.pdf`;

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(pdfData);
    } catch (error) {
      console.error('Erreur lors de l\'export PDF du rapport d\'usage:', error);
      res.status(500).json({ error: 'Erreur lors de l\'export PDF' });
    }
  }

  // Export des entreprises en CSV (super_admin)
  static async exportEntreprisesCSV(req, res) {
    try {
      const csvData = await ExportService.generateEntreprisesCSV();

      const filename = `entreprises_${new Date().toISOString().split('T')[0]}.csv`;

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(csvData);
    } catch (error) {
      console.error('Erreur lors de l\'export CSV des entreprises:', error);
      res.status(500).json({ error: 'Erreur lors de l\'export CSV des entreprises' });
    }
  }
}

module.exports = ExportController;