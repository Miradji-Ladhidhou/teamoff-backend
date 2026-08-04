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
    if (rows.length === 0) return this.buildCsvHeader(null, 'Entreprises', 3) + '"Aucune donnée"';
    return this.buildCsvHeader(null, 'Entreprises', 3) + new Parser({ fields: ['id', 'nom', 'statut'] }).parse(this.sanitizeCsvRows(rows));
  }

    static async generateUtilisateursCSV(id, filters) {
      const preview = await this.getUtilisateursPreview(id, filters, 1000);
      const numCols = preview.columns.length || 4;
      if (!preview.rows.length) return this.buildCsvHeader(filters, 'Utilisateurs', numCols) + '"Aucune donnée"';
      return this.buildCsvHeader(filters, 'Utilisateurs', numCols) + new Parser({ fields: preview.columns }).parse(this.sanitizeCsvRows(preview.rows));
    }
  static async generateStatistiquesCSV(id, filters) {
    const preview = await this.getUsagePreview(id, filters, 1000);
    return this.buildCsvHeader(filters, 'Statistiques', 2) + new Parser({ fields: preview.columns }).parse(this.sanitizeCsvRows(preview.rows));
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

  // Neutralise les valeurs qui déclenchent l'exécution de formules dans Excel /
  // LibreOffice (CSV Injection — OWASP).  Tout champ commençant par = + - @ \t \r
  // reçoit un préfixe apostrophe qui force le traitement en texte littéral.
  static sanitizeCsvCell(value) {
    if (value === null || value === undefined) return value;
    const str = String(value);
    return /^[=+\-@\t\r]/.test(str) ? `'${str}` : value;
  }

  static sanitizeCsvRows(rows) {
    return rows.map((row) =>
      Object.fromEntries(
        Object.entries(row).map(([k, v]) => [k, this.sanitizeCsvCell(v)])
      )
    );
  }

  static formatDate(date) {
    if (!date) return '';
    const s = String(date).split('T')[0];
    const parts = s.split('-');
    if (parts.length !== 3) return String(date);
    return `${parts[2]}-${parts[1]}-${parts[0]}`;
  }

  static buildCsvHeader(filters, exportName, numCols = 1) {
    // Lignes CSV propres : 1ère colonne = contenu, reste = cellules vides
    const pad = numCols > 1 ? ','.repeat(numCols - 1) : '';
    const now = this.formatDate(new Date());
    const lines = [
      `"Export TeamOff - ${exportName}"${pad}`,
      `"Généré le : ${now}"${pad}`,
    ];
    if (filters && (filters.dateDebut || filters.dateFin)) {
      const debut = filters.dateDebut ? this.formatDate(filters.dateDebut) : '-';
      const fin   = filters.dateFin   ? this.formatDate(filters.dateFin)   : '-';
      lines.push(`"Période : du ${debut} au ${fin}"${pad}`);
    }
    lines.push(pad); // ligne vide séparatrice
    return lines.join('\n') + '\n';
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
  static async getCongesPreview(entrepriseId, filters = {}, limit = 50, role = null) {
    const userWhere = {};
    if (filters.service) userWhere.service = filters.service;
    if (role === 'manager') userWhere.role = { [Op.notIn]: ['admin_entreprise', 'super_admin'] };

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
          where: Object.keys(userWhere).length ? userWhere : undefined
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

  static async generateCongesCSV(id, filters, role = null) {
    const preview = await this.getCongesPreview(id, filters, 1000, role);
    const numCols = preview.columns.length || 7;
    if (!preview.rows.length) return this.buildCsvHeader(filters, 'Congés', numCols) + '"Aucune donnée"';
    return this.buildCsvHeader(filters, 'Congés', numCols) + new Parser({ fields: preview.columns }).parse(this.sanitizeCsvRows(preview.rows));
  }

  static async generateCongesPDF(id, filters, entreprise = null, role = null) {
    const preview = await this.getCongesPreview(id, filters, 1000, role);
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
  static async getAbsencesPreview(entrepriseId, filters = {}, limit = 50, role = null) {
    const userWhere = {};
    if (filters.service) userWhere.service = filters.service;
    if (role === 'manager') userWhere.role = { [Op.notIn]: ['admin_entreprise', 'super_admin'] };

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
          where: Object.keys(userWhere).length ? userWhere : undefined
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
      fin: this.formatDate(a.date_fin),
      statut: a.statut,
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

  static async generateAbsencesCSV(id, filters, role = null) {
    const preview = await this.getAbsencesPreview(id, filters, 1000, role);
    const numCols = preview.columns.length || 6;
    if (!preview.rows.length) return this.buildCsvHeader(filters, 'Absences', numCols) + '"Aucune donnée"';
    return this.buildCsvHeader(filters, 'Absences', numCols) + new Parser({ fields: preview.columns }).parse(this.sanitizeCsvRows(preview.rows));
  }

  static async generateAbsencesPDF(id, filters, entreprise = null, role = null) {
    const preview = await this.getAbsencesPreview(id, filters, 1000, role);
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
  static async getArretsMaladiePreview(entrepriseId, filters = {}, limit = 50, role = null) {
    // Fix #51 : même pattern que getAbsencesPreview pour le filtre service.
    const userWhere = {};
    if (filters.service) userWhere.service = filters.service;
    if (role === 'manager') userWhere.role = { [Op.notIn]: ['admin_entreprise', 'super_admin'] };

    const rowsDB = await Absence.findAll({
      where: {
        entreprise_id: entrepriseId,
        type_absence: 'maladie',
        ...this.buildFilters(filters)
      },
      include: [{
        model: Utilisateur,
        as: 'utilisateur',
        attributes: ['prenom','nom','email','service'],
        where: Object.keys(userWhere).length ? userWhere : undefined,
      }],
      order: this.buildOrder(filters.sortBy, filters.sortOrder),
      limit
    });

    const rows = rowsDB.map(a => ({
      employe: `${a.utilisateur?.prenom || ''} ${a.utilisateur?.nom || ''}`,
      email: a.utilisateur?.email,
      service: a.utilisateur?.service,
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

  static async generateArretsMaladieCSV(id, filters, role = null) {
    const preview = await this.getArretsMaladiePreview(id, filters, 1000, role);
    const numCols = preview.columns.length || 4;
    if (!preview.rows.length) return this.buildCsvHeader(filters, 'Arrêts maladie', numCols) + '"Aucune donnée"';
    return this.buildCsvHeader(filters, 'Arrêts maladie', numCols) + new Parser({ fields: preview.columns }).parse(this.sanitizeCsvRows(preview.rows));
  }

  static async generateArretsMaladiePDF(id, filters, entreprise = null, role = null) {
    const preview = await this.getArretsMaladiePreview(id, filters, 1000, role);
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
    // Fix #50 : appliquer les filtres dateDebut / dateFin sur created_at.
    const where = { entreprise_id: entrepriseId };
    if (filters.dateDebut || filters.dateFin) {
      where.created_at = {};
      if (filters.dateDebut) where.created_at[Op.gte] = filters.dateDebut;
      if (filters.dateFin)   where.created_at[Op.lte] = filters.dateFin;
    }

    const rowsDB = await AuditLog.findAll({
      where,
      order: [['created_at','DESC']],
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
    const numCols = preview.columns.length || 4;
    if (!preview.rows.length) return this.buildCsvHeader(filters, "Journal d'audit", numCols) + '"Aucune donnée"';
    return this.buildCsvHeader(filters, "Journal d'audit", numCols) + new Parser({ fields: preview.columns }).parse(this.sanitizeCsvRows(preview.rows));
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
    attributes: ['prenom', 'nom', 'email', 'role', 'service'],
    limit,
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
  const dateFilter = {};
  if (filters.dateDebut || filters.dateFin) {
    dateFilter.date_debut = {};
    if (filters.dateDebut) dateFilter.date_debut[Op.gte] = filters.dateDebut;
    if (filters.dateFin)   dateFilter.date_debut[Op.lte] = filters.dateFin;
  }

  const totalUsers          = await Utilisateur.count({ where: { entreprise_id: entrepriseId } });
  const totalConges         = await Conge.count({ where: { entreprise_id: entrepriseId, ...dateFilter } });
  const totalAbsences       = await Absence.count({ where: { entreprise_id: entrepriseId, type_absence: { [Op.ne]: 'maladie' }, ...dateFilter } });
  const totalArretsMaladie  = await Absence.count({ where: { entreprise_id: entrepriseId, type_absence: 'maladie', ...dateFilter } });

  const rows = [];

  if (filters.dateDebut || filters.dateFin) {
    const debut = filters.dateDebut ? this.formatDate(filters.dateDebut) : '—';
    const fin   = filters.dateFin   ? this.formatDate(filters.dateFin)   : '—';
    rows.push({ Indicateur: 'Période', Valeur: `du ${debut} au ${fin}` });
  }

  rows.push(
    { Indicateur: 'Utilisateurs', Valeur: totalUsers },
    { Indicateur: 'Congés',       Valeur: totalConges },
    { Indicateur: 'Absences',     Valeur: totalAbsences },
    { Indicateur: 'Arrêts maladie', Valeur: totalArretsMaladie }
  );

  return {
    columns: ['Indicateur', 'Valeur'],
    rows,
    count: rows.length,
    limitedTo: rows.length
  };
}

  // =========================
// PREVIEW GLOBAL (CORRIGÉ)
// =========================
static async getPreview(type, entrepriseId, filters, limit, role = null) {
  switch (type) {
    case 'conges':
      return this.getCongesPreview(entrepriseId, filters, limit, role);

    case 'absences':
      return this.getAbsencesPreview(entrepriseId, filters, limit, role);

    case 'arrets_maladie':
      return this.getArretsMaladiePreview(entrepriseId, filters, limit, role);

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