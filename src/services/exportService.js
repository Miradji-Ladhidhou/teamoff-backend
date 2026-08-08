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
    const d = date instanceof Date ? date : new Date(date);
    if (isNaN(d.getTime())) return String(date);
    const iso = d.toISOString().split('T')[0]; // "YYYY-MM-DD"
    const [y, m, day] = iso.split('-');
    return `${day}-${m}-${y}`;
  }

  static buildCsvHeader(filters, exportName, numCols = 1) {
    const pad = numCols > 1 ? ','.repeat(numCols - 1) : '';

    // Date/heure formatée côté navigateur et transmise telle quelle (DD-MM-YYYY HH:MM)
    const nowStr = filters?.generatedAt || (() => {
      const iso = new Date().toISOString();
      return `${iso.slice(8,10)}-${iso.slice(5,7)}-${iso.slice(0,4)} ${iso.slice(11,16)}`;
    })();

    const lines = [
      `"Export TeamOff - ${exportName}"${pad}`,
      `"Généré le : ${nowStr}"${pad}`,
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
        ...(entrepriseId ? { entreprise_id: entrepriseId } : {}),
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
        ...(entrepriseId ? { entreprise_id: entrepriseId } : {}),
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
        ...(entrepriseId ? { entreprise_id: entrepriseId } : {}),
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
    const where = entrepriseId ? { entreprise_id: entrepriseId } : {};

    if (filters.action) where.action = filters.action;

    if (filters.dateDebut || filters.dateFin) {
      where.created_at = {};
      if (filters.dateDebut) where.created_at[Op.gte] = new Date(filters.dateDebut);
      if (filters.dateFin) {
        const fin = new Date(filters.dateFin);
        fin.setHours(23, 59, 59, 999);
        where.created_at[Op.lte] = fin;
      }
    }

    if (filters.search) {
      const s = String(filters.search).slice(0, 100);
      where[Op.or] = [
        { action:      { [Op.iLike]: `%${s}%` } },
        { entity:      { [Op.iLike]: `%${s}%` } },
        { ip_address:  { [Op.iLike]: `%${s}%` } },
        { '$utilisateur.email$':  { [Op.iLike]: `%${s}%` } },
        { '$utilisateur.prenom$': { [Op.iLike]: `%${s}%` } },
        { '$utilisateur.nom$':    { [Op.iLike]: `%${s}%` } },
      ];
    }

    const rowsDB = await AuditLog.findAll({
      where,
      include: [{
        model: Utilisateur,
        as: 'utilisateur',
        attributes: ['prenom', 'nom', 'email'],
        required: false,
      }],
      order: [['created_at', 'DESC']],
      limit,
    });

    const FALLBACK_COLS = ['date', 'action', 'entite', 'utilisateur', 'email', 'ip'];

    const rows = rowsDB.map(l => ({
      date:        this.formatDate(l.createdAt ?? l.created_at),
      action:      l.action || '',
      entite:      l.entity || '',
      utilisateur: l.utilisateur
        ? `${l.utilisateur.prenom || ''} ${l.utilisateur.nom || ''}`.trim()
        : 'Système',
      email: l.utilisateur?.email || '',
      ip:    l.ip_address || '',
    }));

    return {
      columns: rows.length ? Object.keys(rows[0]) : FALLBACK_COLS,
      rows,
      count: rows.length,
      limitedTo: limit,
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
  const where = entrepriseId ? { entreprise_id: entrepriseId } : {};
  const rowsDB = await Utilisateur.findAll({
    where,
    attributes: ['prenom', 'nom', 'email', 'role', 'service', 'statut'],
    order: [['nom', 'ASC'], ['prenom', 'ASC']],
    limit,
  });

  const rows = rowsDB.map(u => ({
    nom: `${u.prenom || ''} ${u.nom || ''}`.trim(),
    email: u.email,
    role: u.role,
    service: u.service || '',
    statut: u.statut || '',
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
  // TOUT (congés + absences + arrêts maladie)
  // =========================
  static async getToutPreview(entrepriseId, filters = {}, limit = 50, role = null) {
    const COLS = ['categorie', 'employe', 'email', 'service', 'type', 'debut', 'fin', 'statut'];

    const [congesP, absencesP, arretsP] = await Promise.all([
      this.getCongesPreview(entrepriseId, filters, limit, role),
      this.getAbsencesPreview(entrepriseId, filters, limit, role),
      this.getArretsMaladiePreview(entrepriseId, filters, limit, role),
    ]);

    const toISO = (ddmmyyyy) => {
      if (!ddmmyyyy) return '';
      const p = ddmmyyyy.split('-');
      return p.length === 3 ? `${p[2]}-${p[1]}-${p[0]}` : ddmmyyyy;
    };

    const asc = (filters.sortOrder || 'desc').toLowerCase() === 'asc' ? 1 : -1;

    const allRows = [
      ...congesP.rows.map(r => ({ categorie: 'Congé', ...r })),
      ...absencesP.rows.map(r => ({ categorie: 'Absence', ...r })),
      ...arretsP.rows.map(r => ({
        categorie: 'Arrêt maladie', employe: r.employe, email: r.email,
        service: r.service, type: '', debut: r.debut, fin: r.fin, statut: '',
      })),
    ].sort((a, b) => toISO(a.debut).localeCompare(toISO(b.debut)) * asc);

    return {
      columns: COLS,
      rows: allRows.slice(0, limit),
      count: allRows.length,
      limitedTo: limit,
    };
  }

  static async generateToutCSV(entrepriseId, filters, role = null) {
    const preview = await this.getToutPreview(entrepriseId, filters, 1000, role);
    const numCols = preview.columns.length;
    if (!preview.rows.length) {
      return this.buildCsvHeader(filters, 'Congés, absences & arrêts maladie', numCols) + '"Aucune donnée"';
    }
    return this.buildCsvHeader(filters, 'Congés, absences & arrêts maladie', numCols) +
      new Parser({ fields: preview.columns }).parse(this.sanitizeCsvRows(preview.rows));
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

    case 'tout':
      return this.getToutPreview(entrepriseId, filters, limit, role);

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