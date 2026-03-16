const { Parser } = require('json2csv');
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
const { Conge, Utilisateur, Entreprise, AuditLog, CongeType } = require('../models');
const { Op } = require('sequelize');

function buildCongeWhereClause(entrepriseId, filters = {}) {
  const whereClause = { entreprise_id: entrepriseId };
  const statutRaw = filters.statut || filters.status;
  const statutMap = {
    en_attente: ['en_attente_manager'],
    approuve: ['valide_manager', 'valide_final'],
    refuse: ['refuse_manager', 'refuse_final'],
    annule: ['annule'],
  };

  if (statutRaw && statutRaw !== 'all') {
    const mapped = statutMap[statutRaw];
    if (mapped && mapped.length > 0) {
      whereClause.statut = { [Op.in]: mapped };
    } else {
      whereClause.statut = statutRaw;
    }
  }

  if (filters.dateDebut || filters.dateFin) {
    whereClause.date_debut = {};
    if (filters.dateDebut) {
      whereClause.date_debut[Op.gte] = filters.dateDebut;
    }
    if (filters.dateFin) {
      whereClause.date_debut[Op.lte] = filters.dateFin;
    }
  }

  if (filters.utilisateur && filters.utilisateur !== 'all' && filters.utilisateur !== 'me') {
    whereClause.utilisateur_id = filters.utilisateur;
  }
  if (filters.utilisateurId && filters.utilisateurId !== 'all') {
    whereClause.utilisateur_id = filters.utilisateurId;
  }

  return whereClause;
}

class ExportService {
  static async getCongesPreview(entrepriseId, filters = {}, limit = 50) {
    const whereClause = buildCongeWhereClause(entrepriseId, filters);
    const conges = await Conge.findAll({
      where: whereClause,
      include: [
        {
          model: Utilisateur,
          as: 'utilisateur',
          attributes: ['prenom', 'nom', 'email'],
          required: false
        },
        {
          model: CongeType,
          as: 'conge_type',
          attributes: ['libelle'],
          required: false
        }
      ],
      order: [['created_at', 'DESC']],
      limit,
    });

    const rows = conges.map(conge => ({
      id: conge.id,
      employe: conge.utilisateur ? `${conge.utilisateur.prenom || ''} ${conge.utilisateur.nom || ''}`.trim() : 'Utilisateur supprimé',
      email: conge.utilisateur?.email || 'N/A',
      type_conge: conge.conge_type?.libelle || 'Type supprimé',
      date_debut: conge.date_debut,
      date_fin: conge.date_fin,
      jours: conge.jours_calcules,
      statut: conge.statut,
      cree_le: conge.created_at,
    }));

    return {
      columns: ['id', 'employe', 'email', 'type_conge', 'date_debut', 'date_fin', 'jours', 'statut', 'cree_le'],
      rows,
      count: rows.length,
      limitedTo: limit,
    };
  }

  static async getUtilisateursPreview(entrepriseId, limit = 50) {
    const utilisateurs = await Utilisateur.findAll({
      where: { entreprise_id: entrepriseId },
      attributes: ['id', 'prenom', 'nom', 'email', 'role', 'statut', 'created_at'],
      order: [['nom', 'ASC']],
      limit,
    });

    const rows = utilisateurs.map(user => ({
      id: user.id,
      prenom: user.prenom,
      nom: user.nom,
      email: user.email,
      role: user.role,
      statut: user.statut,
      inscrit_le: user.created_at,
    }));

    return {
      columns: ['id', 'prenom', 'nom', 'email', 'role', 'statut', 'inscrit_le'],
      rows,
      count: rows.length,
      limitedTo: limit,
    };
  }

  static async getAuditPreview(entrepriseId, filters = {}, limit = 50) {
    const whereClause = { entreprise_id: entrepriseId };

    if (filters.dateDebut || filters.dateFin) {
      whereClause.createdAt = {};
      if (filters.dateDebut) {
        whereClause.createdAt[Op.gte] = new Date(filters.dateDebut);
      }
      if (filters.dateFin) {
        const fin = new Date(filters.dateFin);
        fin.setHours(23, 59, 59, 999);
        whereClause.createdAt[Op.lte] = fin;
      }
    }
    if (filters.action) whereClause.action = filters.action;
    if (filters.utilisateurId) whereClause.user_id = filters.utilisateurId;

    const logs = await AuditLog.findAll({
      where: whereClause,
      include: [
        {
          model: Utilisateur,
          as: 'utilisateur',
          attributes: ['prenom', 'nom', 'email'],
          required: false,
        }
      ],
      order: [['createdAt', 'DESC']],
      limit,
    });

    const rows = logs.map(log => ({
      date: log.createdAt,
      utilisateur: log.utilisateur ? `${log.utilisateur.prenom || ''} ${log.utilisateur.nom || ''}`.trim() : 'Système',
      email: log.utilisateur?.email || '',
      action: log.action,
      entite: log.entity || '',
      ip: log.ip_address || '',
    }));

    return {
      columns: ['date', 'utilisateur', 'email', 'action', 'entite', 'ip'],
      rows,
      count: rows.length,
      limitedTo: limit,
    };
  }

  static async getUsagePreview(entrepriseId) {
    const UsageService = require('./usageService');
    const report = await UsageService.getUsageReport(entrepriseId);

    const rows = [
      { metrique: 'Congés ce mois', valeur: report.congesThisMonth },
      { metrique: 'Utilisateurs actifs', valeur: report.activeUsers },
      { metrique: 'Jours fériés configurés', valeur: report.joursFeries },
      { metrique: 'Limite utilisateurs', valeur: report.limits.maxUsers === -1 ? 'Illimité' : report.limits.maxUsers },
      { metrique: 'Limite congés/mois', valeur: report.limits.maxCongesParMois === -1 ? 'Illimité' : report.limits.maxCongesParMois },
      { metrique: 'Limite jours fériés', valeur: report.limits.maxJoursFeries === -1 ? 'Illimité' : report.limits.maxJoursFeries },
    ];

    return {
      columns: ['metrique', 'valeur'],
      rows,
      count: rows.length,
      limitedTo: rows.length,
    };
  }

  static async getPreview(type, entrepriseId, filters = {}, limit = 50) {
    if (type === 'conges') {
      return this.getCongesPreview(entrepriseId, filters, limit);
    }
    if (type === 'utilisateurs') {
      return this.getUtilisateursPreview(entrepriseId, limit);
    }
    if (type === 'audit') {
      return this.getAuditPreview(entrepriseId, filters, limit);
    }
    if (type === 'usage' || type === 'statistiques') {
      return this.getUsagePreview(entrepriseId);
    }

    throw new Error('Type de prévisualisation non supporté');
  }

  // Générer CSV des congés
  static async generateCongesCSV(entrepriseId, filters = {}) {
    try {
      const whereClause = buildCongeWhereClause(entrepriseId, filters);

      const conges = await Conge.findAll({
        where: whereClause,
        include: [
          {
            model: Utilisateur,
            as: 'utilisateur',
            attributes: ['prenom', 'nom', 'email'],
            required: false // LEFT JOIN pour éviter les erreurs si utilisateur supprimé
          },
          {
            model: CongeType,
            as: 'conge_type',
            attributes: ['libelle'],
            required: false // LEFT JOIN pour éviter les erreurs si type supprimé
          }
        ],
        order: [['created_at', 'DESC']]
      });

      const data = conges.map(conge => ({
        'ID Congé': conge.id,
        'Employé': conge.utilisateur ? `${conge.utilisateur.prenom || ''} ${conge.utilisateur.nom || ''}`.trim() : 'Utilisateur supprimé',
        'Email': conge.utilisateur ? conge.utilisateur.email : 'N/A',
        'Type de congé': conge.conge_type ? conge.conge_type.libelle : 'Type supprimé',
        'Date début': conge.date_debut,
        'Date fin': conge.date_fin,
        'Jours calculés': conge.jours_calcules,
        'Statut': conge.statut,
        'Commentaire employé': conge.commentaire_employe || '',
        'Commentaire manager': conge.commentaire_manager || '',
        'Commentaire admin': conge.commentaire_admin || '',
        'Date de création': conge.created_at,
        'Dernière modification': conge.updated_at
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
        attributes: ['id', 'prenom', 'nom', 'email', 'role', 'statut', 'created_at', 'updated_at'],
        order: [['nom', 'ASC']]
      });

      const data = utilisateurs.map(user => ({
        'ID': user.id,
        'Prénom': user.prenom,
        'Nom': user.nom,
        'Email': user.email,
        'Rôle': user.role,
        'Statut': user.statut,
        'Date d\'inscription': user.created_at,
        'Dernière modification': user.updated_at
      }));

      const fields = ['ID', 'Prénom', 'Nom', 'Email', 'Rôle', 'Statut', 'Date d\'inscription', 'Dernière modification'];

      const json2csvParser = new Parser({ fields });
      return json2csvParser.parse(data);
    } catch (error) {
      console.error('Erreur lors de la génération du CSV des utilisateurs:', error);
      throw error;
    }
  }

  // Générer CSV des entreprises (super_admin)
  static async generateEntreprisesCSV() {
    try {
      const entreprises = await Entreprise.findAll({
        attributes: ['id', 'nom', 'statut', 'logo', 'created_at', 'updated_at'],
        order: [['nom', 'ASC']]
      });

      const data = entreprises.map(entreprise => ({
        'ID': entreprise.id,
        'Nom': entreprise.nom,
        'Statut': entreprise.statut,
        'Logo': entreprise.logo || '',
        'Date de creation': entreprise.created_at,
        'Derniere modification': entreprise.updated_at
      }));

      const fields = ['ID', 'Nom', 'Statut', 'Logo', 'Date de creation', 'Derniere modification'];

      const json2csvParser = new Parser({ fields });
      return json2csvParser.parse(data);
    } catch (error) {
      console.error('Erreur lors de la génération du CSV des entreprises:', error);
      throw error;
    }
  }

  // Générer CSV des logs d'audit
  static async generateAuditLogsCSV(entrepriseId, filters = {}) {
    try {
      const whereClause = { entreprise_id: entrepriseId };

      if (filters.dateDebut || filters.dateFin) {
        whereClause.createdAt = {};
        if (filters.dateDebut) {
          whereClause.createdAt[Op.gte] = new Date(filters.dateDebut);
        }
        if (filters.dateFin) {
          const fin = new Date(filters.dateFin);
          fin.setHours(23, 59, 59, 999);
          whereClause.createdAt[Op.lte] = fin;
        }
      }
      if (filters.action) whereClause.action = filters.action;
      if (filters.utilisateurId) whereClause.user_id = filters.utilisateurId;

      if (filters.search) {
        whereClause[Op.or] = [
          { action: { [Op.iLike]: `%${filters.search}%` } },
          { entity: { [Op.iLike]: `%${filters.search}%` } },
          { ip_address: { [Op.iLike]: `%${filters.search}%` } },
          { '$utilisateur.prenom$': { [Op.iLike]: `%${filters.search}%` } },
          { '$utilisateur.nom$': { [Op.iLike]: `%${filters.search}%` } },
          { '$utilisateur.email$': { [Op.iLike]: `%${filters.search}%` } },
        ];
      }

      const logs = await AuditLog.findAll({
        where: whereClause,
        include: [
          {
            model: Utilisateur,
            as: 'utilisateur',
            attributes: ['prenom', 'nom', 'email'],
            required: false,
          }
        ],
        order: [['createdAt', 'DESC']],
        limit: 1000 // Limiter pour éviter les exports trop volumineux
      });

      const data = logs.map(log => ({
        'Date': log.createdAt,
        'Utilisateur': log.utilisateur ? `${log.utilisateur.prenom || ''} ${log.utilisateur.nom || ''}`.trim() : 'Système',
        'Email': log.utilisateur?.email || '',
        'Action': log.action,
        'Entité': log.entity || '',
        'Détails': JSON.stringify(log.metadata || {}),
        'IP': log.ip_address,
        'User Agent': log.user_agent
      }));

      const fields = ['Date', 'Utilisateur', 'Email', 'Action', 'Entité', 'Détails', 'IP', 'User Agent'];

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
        const whereClause = buildCongeWhereClause(entrepriseId, filters);

        const conges = await Conge.findAll({
          where: whereClause,
          include: [
            {
              model: Utilisateur,
              as: 'utilisateur',
              attributes: ['prenom', 'nom', 'email']
            },
            {
              model: CongeType,
              as: 'conge_type',
              attributes: ['libelle']
            }
          ],
          order: [['created_at', 'DESC']]
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
          en_attente: conges.filter(c => c.statut === 'en_attente_manager').length,
          valide: conges.filter(c => ['valide_manager', 'valide_final'].includes(c.statut)).length,
          refuse: conges.filter(c => ['refuse_manager', 'refuse_final'].includes(c.statut)).length
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
        const UsageService = require('./usageService');
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