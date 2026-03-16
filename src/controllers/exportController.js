const ExportService = require('../services/exportService');

class ExportController {
  // Export des congés en CSV
  static async exportCongesCSV(req, res) {
    try {
      const entrepriseId = req.user.entreprise_id;
      const filters = req.query; // status, dateDebut, dateFin, utilisateurId

      const csvData = await ExportService.generateCongesCSV(entrepriseId, filters);

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
      const entrepriseId = req.user.entreprise_id;
      const filters = req.query; // status, dateDebut, dateFin

      const pdfData = await ExportService.generateCongesPDF(entrepriseId, filters);

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
      const entrepriseId = req.user.entreprise_id;

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
      const entrepriseId = req.user.entreprise_id;
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
      const entrepriseId = req.user.entreprise_id;

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
}

module.exports = ExportController;