const { Absence, Conge, Utilisateur, Entreprise, CongeType, AuditLog } = require('../models');
const { Op } = require('sequelize');
const { Parser } = require('json2csv');
const PDFDocument = require('pdfkit');
const pdfTemplate = require('./pdfTemplate');

class ExportService {
  static async generateEntreprisesCSV() {
    const rows = (await Entreprise.findAll({
      attributes: ['id', 'nom', 'statut'],
      order: [['nom', 'ASC']],
    })).map((e) => ({ id: e.id, nom: e.nom, statut: e.statut }));
    if (rows.length === 0) return '';
    return new Parser({ fields: ['id', 'nom', 'statut'] }).parse(rows);
  }

    static async generateUtilisateursCSV(id, filters) {
      const preview = await this.getUtilisateursPreview(id, filters, 1000);
      return new Parser({ fields: preview.columns }).parse(preview.rows);
    }
  static async generateStatistiquesCSV(id, filters) {
    const preview = await this.getUsagePreview(id, filters, 1000);
    return new Parser({ fields: preview.columns }).parse(preview.rows);
  }

  // =========================
  // PDF HELPER
  // =========================
  static async buildPDF(title, preview, options = {}) {
    return new Promise((resolve, reject) => {
      try {
        const doc = new PDFDocument({ margin: pdfTemplate.PAGE_MARGIN });
        const buffers = [];
        doc.on('data', buffers.push.bind(buffers));
        doc.on('end', () => resolve(Buffer.concat(buffers)));

        // HEADER
        pdfTemplate.addHeader(doc, {
          entreprise: options.entreprise,
          date: options.date || new Date(),
        });
        // KPI bloc bonus
        if (options.kpi) {
          doc.font('Helvetica-Bold').fontSize(12).fillColor(pdfTemplate.MAIN_COLOR);
          doc.text(options.kpi, pdfTemplate.PAGE_MARGIN, doc.y, { align: 'left' });
          doc.moveDown(0.5);
        }
        // TITRE
        pdfTemplate.addTitle(doc, title);
        // FILTRES
        pdfTemplate.addFilters(doc, options.filters || {});
        // TABLEAU
        pdfTemplate.addTable(doc, options.columns || preview.columns.map(col => ({ key: col, label: col, width: 100 })), preview.rows, {
          zebra: true,
          statusColor: options.statusColor || false,
        });
        // FOOTER (pagination sur toutes les pages)
        pdfTemplate.addFooter(doc);
        doc.end();
      } catch (err) {
        reject(err);
      }
    });
  }

  static formatDate(date) {
    if (!date) return '';
    return new Date(date).toLocaleDateString('fr-FR');
  }

  // =========================
  // FILTER BUILDER
  // =========================
  static buildFilters(filters = {}) {
    const where = {};

    if (filters.dateDebut || filters.dateFin) {
      where.date_debut = {};
      if (filters.dateDebut) where.date_debut[Op.gte] = filters.dateDebut;
      if (filters.dateFin) where.date_debut[Op.lte] = filters.dateFin;
    }

    if (filters.statut && filters.statut !== 'all') {
      where.statut = filters.statut;
    }

    return where;
  }

  static buildOrder(sortBy = 'date_debut', sortOrder = 'DESC') {
    const mapping = {
      date_demande: 'created_at',
      date_debut: 'date_debut',
      statut: 'statut'
    };

    const field = mapping[sortBy] || 'date_debut';
    return [[field, sortOrder.toUpperCase()]];
  }

  // =========================
  // CONGES
  // =========================
  static async getCongesPreview(entrepriseId, filters = {}, limit = 50) {

    const rowsDB = await Conge.findAll({
      where: {
        entreprise_id: entrepriseId,
        ...this.buildFilters(filters)
      },
      include: [
        {
          model: Utilisateur,
          as: 'utilisateur',
          attributes: ['prenom','nom','email','service'],
          where: filters.service ? { service: filters.service } : undefined
        },
        { model: CongeType, as: 'conge_type', attributes: ['libelle'] }
      ],
      order: this.buildOrder(filters.sortBy, filters.sortOrder),
      limit
    });

    let rows = rowsDB.map(c => ({
      employe: `${c.utilisateur?.prenom || ''} ${c.utilisateur?.nom || ''}`.trim(),
      email: c.utilisateur?.email,
      service: c.utilisateur?.service,
      type: c.conge_type?.libelle,
      debut: this.formatDate(c.date_debut),
      fin: this.formatDate(c.date_fin),
      statut: c.statut
    }));

    if (filters.salarie) {
      rows = rows.filter(r => r.email === filters.salarie);
    }

    return {
      columns: Object.keys(rows[0] || {}),
      rows,
      count: rows.length,
      limitedTo: limit
    };
  }

  static async generateCongesCSV(id, filters) {
    const preview = await this.getCongesPreview(id, filters, 1000);
    return new Parser({ fields: preview.columns }).parse(preview.rows);
  }

  static async generateCongesPDF(id, filters, entreprise = null) {
    const preview = await this.getCongesPreview(id, filters, 1000);
    // Définir les colonnes avec largeur et label pro
    const columns = [
      { key: 'employe', label: 'Employé', width: 120 },
      { key: 'email', label: 'Email', width: 140 },
      { key: 'service', label: 'Service', width: 80 },
      { key: 'type', label: 'Type', width: 80 },
      { key: 'debut', label: 'Début', width: 70 },
      { key: 'fin', label: 'Fin', width: 70 },
      { key: 'statut', label: 'Statut', width: 70 },
    ];
    // Bloc KPI bonus
    const kpi = `Total lignes : ${preview.rows.length}`;
    return this.buildPDF('Rapport des Congés', preview, {
      entreprise,
      filters,
      columns,
      statusColor: true,
      kpi,
    });
  }

  // =========================
  // ABSENCES
  // =========================
  static async getAbsencesPreview(entrepriseId, filters = {}, limit = 50) {

    const rowsDB = await Absence.findAll({
      where: {
        entreprise_id: entrepriseId,
        type_absence: { [Op.ne]: 'maladie' },
        ...this.buildFilters(filters)
      },
      include: [
        {
          model: Utilisateur,
          as: 'utilisateur',
          attributes: ['prenom','nom','email','service'],
          where: filters.service ? { service: filters.service } : undefined
        }
      ],
      order: this.buildOrder(filters.sortBy, filters.sortOrder),
      limit
    });

    let rows = rowsDB.map(a => ({
      employe: `${a.utilisateur?.prenom || ''} ${a.utilisateur?.nom || ''}`,
      email: a.utilisateur?.email,
      service: a.utilisateur?.service,
      type: a.type_absence,
      debut: this.formatDate(a.date_debut),
      fin: this.formatDate(a.date_fin)
    }));

    if (filters.salarie) {
      rows = rows.filter(r => r.email === filters.salarie);
    }

    return {
      columns: Object.keys(rows[0] || {}),
      rows,
      count: rows.length,
      limitedTo: limit
    };
  }

  static async generateAbsencesCSV(id, filters) {
    const preview = await this.getAbsencesPreview(id, filters, 1000);
    return new Parser({ fields: preview.columns }).parse(preview.rows);
  }

  static async generateAbsencesPDF(id, filters, entreprise = null) {
    const preview = await this.getAbsencesPreview(id, filters, 1000);
    const columns = [
      { key: 'employe', label: 'Employé', width: 120 },
      { key: 'email', label: 'Email', width: 140 },
      { key: 'service', label: 'Service', width: 80 },
      { key: 'type', label: 'Type', width: 80 },
      { key: 'debut', label: 'Début', width: 70 },
      { key: 'fin', label: 'Fin', width: 70 },
      { key: 'statut', label: 'Statut', width: 70 },
    ];
    const kpi = `Total lignes : ${preview.rows.length}`;
    return this.buildPDF('Rapport des Absences', preview, {
      entreprise,
      filters,
      columns,
      statusColor: true,
      kpi,
    });
  }

  // =========================
  // ARRETS MALADIE
  // =========================
  static async getArretsMaladiePreview(entrepriseId, filters = {}, limit = 50) {

    const rowsDB = await Absence.findAll({
      where: {
        entreprise_id: entrepriseId,
        type_absence: 'maladie',
        ...this.buildFilters(filters)
      },
      include: [{ model: Utilisateur, as: 'utilisateur', attributes: ['prenom','nom','email'] }],
      order: this.buildOrder(filters.sortBy, filters.sortOrder),
      limit
    });

    const rows = rowsDB.map(a => ({
      employe: `${a.utilisateur?.prenom || ''} ${a.utilisateur?.nom || ''}`,
      email: a.utilisateur?.email,
      debut: this.formatDate(a.date_debut),
      fin: this.formatDate(a.date_fin)
    }));

    return {
      columns: Object.keys(rows[0] || {}),
      rows,
      count: rows.length,
      limitedTo: limit
    };
  }

  static async generateArretsMaladieCSV(id, filters) {
    const preview = await this.getArretsMaladiePreview(id, filters, 1000);
    return new Parser({ fields: preview.columns }).parse(preview.rows);
  }

  static async generateArretsMaladiePDF(id, filters, entreprise = null) {
    const preview = await this.getArretsMaladiePreview(id, filters, 1000);
    const columns = [
      { key: 'employe', label: 'Employé', width: 120 },
      { key: 'email', label: 'Email', width: 140 },
      { key: 'debut', label: 'Début', width: 80 },
      { key: 'fin', label: 'Fin', width: 80 },
    ];
    const kpi = `Total lignes : ${preview.rows.length}`;
    return this.buildPDF('Arrêts Maladie', preview, {
      entreprise,
      filters,
      columns,
      kpi,
    });
  }

  // =========================
  // AUDIT
  // =========================
  static async getAuditPreview(entrepriseId, filters = {}, limit = 50) {

    const rowsDB = await AuditLog.findAll({
      where: { entreprise_id: entrepriseId },
      order: [['createdAt','DESC']],
      limit
    });

    const rows = rowsDB.map(l => ({
      date: this.formatDate(l.createdAt),
      action: l.action,
      entite: l.entity,
      utilisateur: l.user_id
    }));

    return {
      columns: Object.keys(rows[0] || {}),
      rows,
      count: rows.length,
      limitedTo: limit
    };
  }

  static async generateAuditLogsCSV(id, filters) {
    const preview = await this.getAuditPreview(id, filters, 1000);
    return new Parser({ fields: preview.columns }).parse(preview.rows);
  }

  // =========================
  // USAGE
  // =========================
  static async generateUsageReportPDF(id) {
    return this.buildPDF('Rapport Usage', {
      columns: ['Entreprise'],
      rows: [{ Entreprise: id }]
    });
  }

static async getUtilisateursPreview(entrepriseId, filters = {}, limit = 50) {
  const rowsDB = await Utilisateur.findAll({
    where: { entreprise_id: entrepriseId },
    limit
  });

  const rows = rowsDB.map(u => ({
    nom: `${u.prenom || ''} ${u.nom || ''}`.trim(),
    email: u.email,
    role: u.role,
    service: u.service
  }));

  return {
    columns: Object.keys(rows[0] || {}),
    rows,
    count: rows.length,
    limitedTo: limit
  };
}

static async getUsagePreview(entrepriseId, filters = {}, limit = 50) {


  const totalUsers = await Utilisateur.count({ where: { entreprise_id: entrepriseId } });
  const totalConges = await Conge.count({ where: { entreprise_id: entrepriseId } });
  const totalAbsences = await Absence.count({ where: { entreprise_id: entrepriseId, type_absence: { [Op.ne]: 'maladie' } } });
  const totalArretsMaladie = await Absence.count({ where: { entreprise_id: entrepriseId, type_absence: 'maladie' } });

  const rows = [
    { metric: 'Utilisateurs', value: totalUsers },
    { metric: 'Congés', value: totalConges },
    { metric: 'Absences', value: totalAbsences },
    { metric: 'Arrêts maladie', value: totalArretsMaladie }
  ];

  return {
    columns: ['metric', 'value'],
    rows,
    count: rows.length,
    limitedTo: rows.length
  };
}

  // =========================
// PREVIEW GLOBAL (CORRIGÉ)
// =========================
static async getPreview(type, entrepriseId, filters, limit) {
  switch (type) {
    case 'conges':
      return this.getCongesPreview(entrepriseId, filters, limit);

    case 'absences':
      return this.getAbsencesPreview(entrepriseId, filters, limit);

    case 'arrets_maladie':
      return this.getArretsMaladiePreview(entrepriseId, filters, limit);

    case 'audit':
      return this.getAuditPreview(entrepriseId, filters, limit);

    case 'utilisateurs':
      return this.getUtilisateursPreview(entrepriseId, filters, limit);

    case 'usage':
    case 'statistiques':
      return this.getUsagePreview(entrepriseId, filters, limit);

    default:
      throw new Error(`Type non supporté: ${type}`);
  }
}
}

module.exports = ExportService;