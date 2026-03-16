const { Parser } = require('json2csv');
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
const { Conge, Utilisateur, Entreprise, AuditLog, CompteurConges } = require('../models');
const { Op } = require('sequelize');

class ExportService {
  // Générer CSV des congés
  static async generateCongesCSV(entrepriseId, filters = {}) {
    try {
      const whereClause = { entreprise_id: entrepriseId };

      // Appliquer les filtres
      if (filters.status) whereClause.statut = filters.status;
      if (filters.dateDebut && filters.dateFin) {
        whereClause.date_debut = {
          [Op.between]: [filters.dateDebut, filters.dateFin]
        };
      }
      if (filters.utilisateurId) whereClause.utilisateur_id = filters.utilisateurId;

      const conges = await Conge.findAll({
        where: whereClause,
        include: [
          {
            model: Utilisateur,
            as: 'utilisateur',
            attributes: ['prenom', 'nom', 'email']
          },
          {
            model: CompteurConges,
            as: 'conge_type',
            attributes: ['libelle']
          }
        ],
        order: [['createdAt', 'DESC']]
      });

      const data = conges.map(conge => ({
        'ID Congé': conge.id,
        'Employé': `${conge.utilisateur.prenom} ${conge.utilisateur.nom}`,
        'Email': conge.utilisateur.email,
        'Type de congé': conge.conge_type.libelle,
        'Date début': conge.date_debut,
        'Date fin': conge.date_fin,
        'Jours calculés': conge.jours_calcules,
        'Statut': conge.statut,
        'Commentaire employé': conge.commentaire_employe || '',
        'Commentaire manager': conge.commentaire_manager || '',
        'Commentaire admin': conge.commentaire_admin || '',
        'Date de création': conge.createdAt,
        'Dernière modification': conge.updatedAt
      }));

      const fields = [
        'ID Congé', 'Employé', 'Email', 'Type de congé', 'Date début', 'Date fin',
        'Jours calculés', 'Statut', 'Commentaire employé', 'Commentaire manager',
        'Commentaire admin', 'Date de création', 'Dernière modification'
      ];

      const json2csvParser = new Parser({ fields });
      return json2csvParser.parse(data);
    } catch (error) {
      console.error('Erreur lors de la génération du CSV des congés:', error);
      throw error;
    }
  }

  // Générer CSV des utilisateurs
  static async generateUtilisateursCSV(entrepriseId) {
    try {
      const utilisateurs = await Utilisateur.findAll({
        where: { entreprise_id: entrepriseId },
        attributes: ['id', 'prenom', 'nom', 'email', 'role', 'is_active', 'createdAt', 'last_login'],
        order: [['nom', 'ASC']]
      });

      const data = utilisateurs.map(user => ({
        'ID': user.id,
        'Prénom': user.prenom,
        'Nom': user.nom,
        'Email': user.email,
        'Rôle': user.role,
        'Actif': user.is_active ? 'Oui' : 'Non',
        'Date d\'inscription': user.createdAt,
        'Dernière connexion': user.last_login || 'Jamais'
      }));

      const fields = ['ID', 'Prénom', 'Nom', 'Email', 'Rôle', 'Actif', 'Date d\'inscription', 'Dernière connexion'];

      const json2csvParser = new Parser({ fields });
      return json2csvParser.parse(data);
    } catch (error) {
      console.error('Erreur lors de la génération du CSV des utilisateurs:', error);
      throw error;
    }
  }

  // Générer CSV des logs d'audit
  static async generateAuditLogsCSV(entrepriseId, filters = {}) {
    try {
      const whereClause = { entreprise_id: entrepriseId };

      if (filters.dateDebut && filters.dateFin) {
        whereClause.timestamp = {
          [Op.between]: [filters.dateDebut, filters.dateFin]
        };
      }
      if (filters.action) whereClause.action = filters.action;
      if (filters.utilisateurId) whereClause.utilisateur_id = filters.utilisateurId;

      const logs = await AuditLog.findAll({
        where: whereClause,
        include: [
          {
            model: Utilisateur,
            as: 'utilisateur',
            attributes: ['prenom', 'nom', 'email']
          }
        ],
        order: [['timestamp', 'DESC']],
        limit: 1000 // Limiter pour éviter les exports trop volumineux
      });

      const data = logs.map(log => ({
        'Date': log.timestamp,
        'Utilisateur': log.utilisateur ? `${log.utilisateur.prenom} ${log.utilisateur.nom}` : 'Système',
        'Action': log.action,
        'Détails': log.details,
        'IP': log.ip_address,
        'User Agent': log.user_agent
      }));

      const fields = ['Date', 'Utilisateur', 'Action', 'Détails', 'IP', 'User Agent'];

      const json2csvParser = new Parser({ fields });
      return json2csvParser.parse(data);
    } catch (error) {
      console.error('Erreur lors de la génération du CSV des logs d\'audit:', error);
      throw error;
    }
  }

  // Générer PDF des congés
  static async generateCongesPDF(entrepriseId, filters = {}) {
    return new Promise(async (resolve, reject) => {
      try {
        const entreprise = await Entreprise.findByPk(entrepriseId);
        const whereClause = { entreprise_id: entrepriseId };

        // Appliquer les filtres
        if (filters.status) whereClause.statut = filters.status;
        if (filters.dateDebut && filters.dateFin) {
          whereClause.date_debut = {
            [Op.between]: [filters.dateDebut, filters.dateFin]
          };
        }

        const conges = await Conge.findAll({
          where: whereClause,
          include: [
            {
              model: Utilisateur,
              as: 'utilisateur',
              attributes: ['prenom', 'nom', 'email']
            },
            {
              model: CompteurConges,
              as: 'conge_type',
              attributes: ['libelle']
            }
          ],
          order: [['createdAt', 'DESC']]
        });

        // Créer le document PDF
        const doc = new PDFDocument();
        const buffers = [];

        doc.on('data', buffers.push.bind(buffers));
        doc.on('end', () => {
          const pdfData = Buffer.concat(buffers);
          resolve(pdfData);
        });

        // En-tête
        doc.fontSize(20).text(`Rapport des Congés - ${entreprise.nom}`, { align: 'center' });
        doc.moveDown();
        doc.fontSize(12).text(`Généré le ${new Date().toLocaleDateString('fr-FR')}`, { align: 'center' });
        doc.moveDown(2);

        // Statistiques
        const stats = {
          total: conges.length,
          en_attente: conges.filter(c => c.statut === 'en_attente').length,
          valide: conges.filter(c => c.statut === 'valide').length,
          refuse: conges.filter(c => c.statut === 'refuse').length
        };

        doc.fontSize(14).text('Statistiques', { underline: true });
        doc.moveDown();
        doc.fontSize(10);
        doc.text(`Total des congés: ${stats.total}`);
        doc.text(`En attente: ${stats.en_attente}`);
        doc.text(`Validés: ${stats.valide}`);
        doc.text(`Refusés: ${stats.refuse}`);
        doc.moveDown(2);

        // Tableau des congés
        doc.fontSize(14).text('Détail des Congés', { underline: true });
        doc.moveDown();

        conges.forEach((conge, index) => {
          if (index > 0) doc.moveDown();

          doc.fontSize(10);
          doc.text(`Congé #${conge.id}`, { bold: true });
          doc.text(`Employé: ${conge.utilisateur.prenom} ${conge.utilisateur.nom}`);
          doc.text(`Type: ${conge.conge_type.libelle}`);
          doc.text(`Période: ${conge.date_debut} au ${conge.date_fin}`);
          doc.text(`Jours: ${conge.jours_calcules}`);
          doc.text(`Statut: ${conge.statut}`);
          if (conge.commentaire_employe) {
            doc.text(`Commentaire: ${conge.commentaire_employe}`);
          }
          doc.moveDown();
        });

        doc.end();
      } catch (error) {
        reject(error);
      }
    });
  }

  // Générer PDF du rapport d'usage
  static async generateUsageReportPDF(entrepriseId) {
    return new Promise(async (resolve, reject) => {
      try {
        const entreprise = await Entreprise.findByPk(entrepriseId);
        const { UsageService } = require('./usageService');
        const report = await UsageService.getUsageReport(entrepriseId);

        const doc = new PDFDocument();
        const buffers = [];

        doc.on('data', buffers.push.bind(buffers));
        doc.on('end', () => {
          const pdfData = Buffer.concat(buffers);
          resolve(pdfData);
        });

        // En-tête
        doc.fontSize(20).text(`Rapport d'Usage - ${entreprise.nom}`, { align: 'center' });
        doc.moveDown();
        doc.fontSize(12).text(`Généré le ${new Date().toLocaleDateString('fr-FR')}`, { align: 'center' });
        doc.moveDown(2);

        // Métriques d'usage
        doc.fontSize(14).text('Métriques d\'Usage', { underline: true });
        doc.moveDown();
        doc.fontSize(10);
        doc.text(`Congés ce mois: ${report.congesThisMonth}`);
        doc.text(`Utilisateurs actifs: ${report.activeUsers}`);
        doc.text(`Jours fériés configurés: ${report.joursFeries}`);
        doc.moveDown(2);

        // Limites du plan
        doc.fontSize(14).text('Limites du Plan', { underline: true });
        doc.moveDown();
        doc.fontSize(10);
        doc.text(`Utilisateurs max: ${report.limits.maxUsers === -1 ? 'Illimité' : report.limits.maxUsers}`);
        doc.text(`Congés/mois max: ${report.limits.maxCongesParMois === -1 ? 'Illimité' : report.limits.maxCongesParMois}`);
        doc.text(`Jours fériés max: ${report.limits.maxJoursFeries === -1 ? 'Illimité' : report.limits.maxJoursFeries}`);
        doc.moveDown(2);

        // Calcul des pourcentages d'usage
        const userUsagePercent = report.limits.maxUsers === -1 ? 0 : (report.activeUsers / report.limits.maxUsers) * 100;
        const congesUsagePercent = report.limits.maxCongesParMois === -1 ? 0 : (report.congesThisMonth / report.limits.maxCongesParMois) * 100;

        doc.fontSize(14).text('Taux d\'Utilisation', { underline: true });
        doc.moveDown();
        doc.fontSize(10);
        doc.text(`Utilisateurs: ${userUsagePercent.toFixed(1)}%`);
        doc.text(`Congés ce mois: ${congesUsagePercent.toFixed(1)}%`);

        doc.end();
      } catch (error) {
        reject(error);
      }
    });
  }

  // Méthode utilitaire pour formater les dates
  static formatDate(date) {
    return new Date(date).toLocaleDateString('fr-FR');
  }

  // Méthode utilitaire pour formater les périodes
  static formatPeriod(dateDebut, dateFin) {
    return `${this.formatDate(dateDebut)} - ${this.formatDate(dateFin)}`;
  }
}

module.exports = ExportService;