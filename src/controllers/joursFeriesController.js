// controllers/joursFeriesController.js
const { JoursFeries, HolidayTemplate, HolidayTemplateItem, sequelize } = require('../models');
const { Op } = require('sequelize');
const { auditFerie } = require('../services/auditHelper');
const { Parser } = require('json2csv');

function getTargetEntrepriseId(req, { allowBody = false } = {}) {
  if (req.user?.role === 'super_admin') {
    if (allowBody && req.body?.entreprise_id) {
      return req.body.entreprise_id;
    }
    return req.query?.entreprise_id || req.body?.entreprise_id || null;
  }

  return req.user?.entreprise_id || null;
}

function toBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1;
  if (typeof value !== 'string') return false;
  const v = value.trim().toLowerCase();
  return ['1', 'true', 'oui', 'yes', 'y'].includes(v);
}

function parseCsvLine(line = '') {
  const out = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    const next = line[i + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      out.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }

  out.push(current.trim());
  return out;
}

function parseHolidayCsv(csvContent = '') {
  const lines = csvContent
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length < 2) {
    return [];
  }

  const headers = parseCsvLine(lines[0]).map((h) => h.toLowerCase());
  const idx = {
    date: headers.indexOf('date'),
    libelle: headers.indexOf('libelle'),
    recurrent: headers.indexOf('recurrent'),
    est_travail: headers.indexOf('est_travail'),
  };

  if (idx.date < 0 || idx.libelle < 0) {
    throw new Error('CSV invalide: colonnes attendues date, libelle, recurrent, est_travail');
  }

  return lines.slice(1).map((line) => {
    const cols = parseCsvLine(line);
    return {
      date: cols[idx.date],
      libelle: cols[idx.libelle],
      recurrent: idx.recurrent >= 0 ? toBoolean(cols[idx.recurrent]) : false,
      est_travail: idx.est_travail >= 0 ? toBoolean(cols[idx.est_travail]) : false,
    };
  }).filter((item) => item.date && item.libelle);
}

// ----------------------------
// Lister tous les jours fériés
// ----------------------------
async function listerJoursFeries(req, res, next) {
  try {
    const entrepriseId = getTargetEntrepriseId(req);
    if (!entrepriseId) {
      return res.status(400).json({ message: 'entreprise_id est requis pour ce profil.' });
    }

    const joursFeries = await JoursFeries.findAll({
      where: { entreprise_id: entrepriseId },
      order: [['date', 'ASC']]
    });
    res.json(joursFeries);
  } catch (err) {
    next(err);
  }
}

// ----------------------------
// Création d'un jour férié
// ----------------------------
async function creerJourFerie(req, res, next) {
  const t = await sequelize.transaction();
  try {
    const { date, libelle, recurrent, est_travail } = req.body;
    const entrepriseId = getTargetEntrepriseId(req, { allowBody: true });
    if (!entrepriseId) {
      await t.rollback();
      return res.status(400).json({ message: 'entreprise_id est requis pour ce profil.' });
    }

    const jourFerie = await JoursFeries.create({
      entreprise_id: entrepriseId,
      date,
      libelle,
      recurrent: Boolean(recurrent),
      est_travail: Boolean(est_travail),
    }, { transaction: t });

    await auditFerie.created(jourFerie, req.user, req, { transaction: t });

    await t.commit();
    res.status(201).json(jourFerie);
  } catch (err) {
    await t.rollback();
    if (err.name === 'SequelizeUniqueConstraintError') {
      return res.status(409).json({ message: "Jour férié déjà existant" });
    }
    next(err);
  }
}

// ----------------------------
// Détail d'un jour férié
// ----------------------------
async function getJourFerie(req, res, next) {
  try {
    const entrepriseId = getTargetEntrepriseId(req);
    if (!entrepriseId) {
      return res.status(400).json({ message: 'entreprise_id est requis pour ce profil.' });
    }

    const jourFerie = await JoursFeries.findOne({
      where: { id: req.params.id, entreprise_id: entrepriseId }
    });
    if (!jourFerie) return res.status(404).json({ message: "Jour férié introuvable" });
    res.json(jourFerie);
  } catch (err) {
    next(err);
  }
}

// ----------------------------
// Mise à jour d'un jour férié
// ----------------------------
async function updateJourFerie(req, res, next) {
  const t = await sequelize.transaction();
  try {
    const { date, libelle, recurrent, est_travail } = req.body;
    const entrepriseId = getTargetEntrepriseId(req, { allowBody: true });
    if (!entrepriseId) {
      await t.rollback();
      return res.status(400).json({ message: 'entreprise_id est requis pour ce profil.' });
    }

    const jourFerie = await JoursFeries.findOne({
      where: { id: req.params.id, entreprise_id: entrepriseId },
      transaction: t
    });
    if (!jourFerie) throw new Error("Jour férié introuvable");

    const oldData = {
      libelle: jourFerie.libelle,
      date: jourFerie.date,
      recurrent: jourFerie.recurrent,
      est_travail: jourFerie.est_travail,
    };

    await jourFerie.update(
      {
        date,
        libelle,
        recurrent: Boolean(recurrent),
        est_travail: Boolean(est_travail),
      },
      { transaction: t }
    );

    await auditFerie.updated(jourFerie, req.user, req, {
      oldData,
      updates: {
        date,
        libelle,
        recurrent: Boolean(recurrent),
        est_travail: Boolean(est_travail),
      },
      transaction: t,
    });

    await t.commit();
    res.json(jourFerie);
  } catch (err) {
    await t.rollback();
    if (err.name === 'SequelizeUniqueConstraintError') {
      return res.status(409).json({ message: "Jour férié déjà existant" });
    }
    next(err);
  }
}

// ----------------------------
// Suppression d'un jour férié
// ----------------------------
async function supprimerJourFerie(req, res, next) {
  const t = await sequelize.transaction();
  try {
    const entrepriseId = getTargetEntrepriseId(req);
    if (!entrepriseId) {
      await t.rollback();
      return res.status(400).json({ message: 'entreprise_id est requis pour ce profil.' });
    }

    const jourFerie = await JoursFeries.findOne({
      where: { id: req.params.id, entreprise_id: entrepriseId },
      transaction: t
    });
    if (!jourFerie) throw new Error("Jour férié introuvable");

    await jourFerie.destroy({ transaction: t });

    await auditFerie.deleted(jourFerie, req.user, req, { transaction: t });

    await t.commit();
    res.status(204).send();
  } catch (err) {
    await t.rollback();
    next(err);
  }
}

async function importerJoursFeriesNationaux(req, res, next) {
  const t = await sequelize.transaction();
  try {
    const entrepriseId = getTargetEntrepriseId(req, { allowBody: true });
    if (!entrepriseId) {
      await t.rollback();
      return res.status(400).json({ message: 'entreprise_id est requis pour ce profil.' });
    }

    const year = Number(req.params.year || req.body?.year || new Date().getFullYear());
    const countryCode = String(req.query.country || req.body?.country || 'FR').toUpperCase();

    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      await t.rollback();
      return res.status(400).json({ message: 'Année invalide.' });
    }

    const response = await fetch(`https://date.nager.at/api/v3/PublicHolidays/${year}/${countryCode}`);
    if (!response.ok) {
      await t.rollback();
      return res.status(502).json({ message: 'Impossible de récupérer les jours fériés depuis l\'API externe.' });
    }

    const apiHolidays = await response.json();
    if (!Array.isArray(apiHolidays)) {
      await t.rollback();
      return res.status(502).json({ message: 'Réponse API jours fériés invalide.' });
    }

    const dates = apiHolidays
      .map((h) => h?.date)
      .filter(Boolean);

    const existing = await JoursFeries.findAll({
      where: {
        entreprise_id: entrepriseId,
        date: {
          [Op.in]: dates,
        },
      },
      transaction: t,
    });

    const existingDates = new Set(existing.map((e) => e.date));
    const toCreate = apiHolidays
      .filter((h) => h?.date && !existingDates.has(h.date))
      .map((h) => ({
        entreprise_id: entrepriseId,
        date: h.date,
        libelle: h.localName || h.name || `Jour férié ${h.date}`,
        recurrent: false,
        est_travail: false,
      }));

    if (toCreate.length > 0) {
      await JoursFeries.bulkCreate(toCreate, { transaction: t });
    }

    await t.commit();

    return res.json({
      message: 'Import des jours fériés terminé.',
      imported: toCreate.length,
      skipped: apiHolidays.length - toCreate.length,
      total: apiHolidays.length,
    });
  } catch (err) {
    await t.rollback();
    next(err);
  }
}

async function listerModelesJoursFeries(req, res, next) {
  try {
    const region = req.query.region;
    const search = req.query.search;

    const where = {};
    if (region) {
      where.region = region;
    }
    if (search) {
      where[Op.or] = [
        { name: { [Op.iLike]: `%${search}%` } },
        { region: { [Op.iLike]: `%${search}%` } },
      ];
    }

    const templates = await HolidayTemplate.findAll({
      where,
      include: [
        {
          model: HolidayTemplateItem,
          as: 'items',
          attributes: ['id'],
        },
      ],
      order: [['created_at', 'DESC']],
    });

    const payload = templates.map((t) => ({
      id: t.id,
      name: t.name,
      region: t.region,
      country_code: t.country_code,
      source_entreprise_id: t.source_entreprise_id,
      created_at: t.created_at,
      itemsCount: Array.isArray(t.items) ? t.items.length : 0,
    }));

    return res.json(payload);
  } catch (err) {
    next(err);
  }
}

async function creerModeleJoursFeries(req, res, next) {
  const t = await sequelize.transaction();
  try {
    const { name, region, countryCode, sourceEntrepriseId } = req.body || {};
    if (!name || !String(name).trim()) {
      await t.rollback();
      return res.status(400).json({ message: 'Le nom du modèle est requis.' });
    }

    const entrepriseId = req.user?.role === 'super_admin'
      ? (sourceEntrepriseId || req.query?.entreprise_id)
      : req.user?.entreprise_id;

    if (!entrepriseId) {
      await t.rollback();
      return res.status(400).json({ message: 'Entreprise source introuvable.' });
    }

    const jours = await JoursFeries.findAll({
      where: { entreprise_id: entrepriseId },
      order: [['date', 'ASC']],
      transaction: t,
    });

    const template = await HolidayTemplate.create({
      name: String(name).trim(),
      region: region ? String(region).trim() : null,
      country_code: (countryCode || 'FR').toUpperCase(),
      created_by: req.user?.id || null,
      source_entreprise_id: entrepriseId,
    }, { transaction: t });

    const items = jours.map((jf) => ({
      template_id: template.id,
      date: jf.date,
      libelle: jf.libelle,
      recurrent: Boolean(jf.recurrent),
      est_travail: Boolean(jf.est_travail),
    }));

    if (items.length > 0) {
      await HolidayTemplateItem.bulkCreate(items, { transaction: t });
    }

    await t.commit();
    return res.status(201).json({
      id: template.id,
      name: template.name,
      region: template.region,
      itemsCount: items.length,
    });
  } catch (err) {
    await t.rollback();
    next(err);
  }
}

async function exporterModeleJoursFeriesCsv(req, res, next) {
  try {
    const template = await HolidayTemplate.findByPk(req.params.id, {
      include: [
        {
          model: HolidayTemplateItem,
          as: 'items',
          order: [['date', 'ASC']],
        },
      ],
    });

    if (!template) {
      return res.status(404).json({ message: 'Modèle introuvable.' });
    }

    const rows = (template.items || []).map((item) => ({
      date: item.date,
      libelle: item.libelle,
      recurrent: item.recurrent ? 'true' : 'false',
      est_travail: item.est_travail ? 'true' : 'false',
    }));

    const parser = new Parser({ fields: ['date', 'libelle', 'recurrent', 'est_travail'] });
    const csv = parser.parse(rows);
    const fileName = `holiday_template_${template.name.replace(/\s+/g, '_').toLowerCase()}.csv`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    return res.status(200).send(csv);
  } catch (err) {
    next(err);
  }
}

async function importerModeleJoursFeriesCsv(req, res, next) {
  const t = await sequelize.transaction();
  try {
    const { name, region, countryCode, csvContent } = req.body || {};
    if (!name || !String(name).trim()) {
      await t.rollback();
      return res.status(400).json({ message: 'Le nom du modèle est requis.' });
    }
    if (!csvContent || !String(csvContent).trim()) {
      await t.rollback();
      return res.status(400).json({ message: 'Le contenu CSV est requis.' });
    }

    const parsedItems = parseHolidayCsv(String(csvContent));
    if (parsedItems.length === 0) {
      await t.rollback();
      return res.status(400).json({ message: 'Le CSV ne contient aucune ligne exploitable.' });
    }

    const template = await HolidayTemplate.create({
      name: String(name).trim(),
      region: region ? String(region).trim() : null,
      country_code: (countryCode || 'FR').toUpperCase(),
      created_by: req.user?.id || null,
      source_entreprise_id: null,
    }, { transaction: t });

    const items = parsedItems.map((item) => ({
      template_id: template.id,
      date: item.date,
      libelle: item.libelle,
      recurrent: Boolean(item.recurrent),
      est_travail: Boolean(item.est_travail),
    }));

    await HolidayTemplateItem.bulkCreate(items, { transaction: t });
    await t.commit();

    return res.status(201).json({
      id: template.id,
      name: template.name,
      region: template.region,
      itemsCount: items.length,
    });
  } catch (err) {
    await t.rollback();
    next(err);
  }
}

async function appliquerModeleJoursFeries(req, res, next) {
  const t = await sequelize.transaction();
  try {
    const template = await HolidayTemplate.findByPk(req.params.id, {
      include: [{ model: HolidayTemplateItem, as: 'items' }],
      transaction: t,
    });

    if (!template) {
      await t.rollback();
      return res.status(404).json({ message: 'Modèle introuvable.' });
    }

    const targetEntrepriseId = getTargetEntrepriseId(req, { allowBody: true });
    if (!targetEntrepriseId) {
      await t.rollback();
      return res.status(400).json({ message: 'entreprise_id cible requis.' });
    }

    const replaceExisting = Boolean(req.body?.replaceExisting);
    if (replaceExisting) {
      await JoursFeries.destroy({
        where: { entreprise_id: targetEntrepriseId },
        transaction: t,
      });
    }

    const items = template.items || [];
    let created = 0;
    let updated = 0;

    for (const item of items) {
      const existing = await JoursFeries.findOne({
        where: {
          entreprise_id: targetEntrepriseId,
          date: item.date,
        },
        transaction: t,
      });

      if (existing) {
        await existing.update({
          libelle: item.libelle,
          recurrent: item.recurrent,
          est_travail: item.est_travail,
        }, { transaction: t });
        updated += 1;
      } else {
        await JoursFeries.create({
          entreprise_id: targetEntrepriseId,
          date: item.date,
          libelle: item.libelle,
          recurrent: item.recurrent,
          est_travail: item.est_travail,
        }, { transaction: t });
        created += 1;
      }
    }

    await t.commit();

    return res.json({
      message: 'Modèle appliqué avec succès.',
      created,
      updated,
      total: items.length,
    });
  } catch (err) {
    await t.rollback();
    next(err);
  }
}

// ----------------------------
// Jours fériés par mois (accessible à tous les rôles — pour le calendrier)
// ----------------------------
async function getJoursFeriesByMonth(req, res, next) {
  try {
    const { year, month } = req.params;

    const yearNum = parseInt(year, 10);
    const monthNum = parseInt(month, 10);
    if (!yearNum || monthNum < 1 || monthNum > 12) {
      return res.status(400).json({ message: 'Paramètres year/month invalides.' });
    }

    // Entreprise cible :
    // - super_admin : query.entreprise_id si fourni, sinon son propre entreprise_id
    // - autres rôles : leur propre entreprise_id
    let entrepriseId;
    if (req.user?.role === 'super_admin') {
      entrepriseId = req.query.entreprise_id || req.user?.entreprise_id || null;
    } else {
      entrepriseId = req.user?.entreprise_id || null;
    }

    if (!entrepriseId) {
      return res.status(400).json({ message: 'entreprise_id est requis.' });
    }

    const startDate = new Date(yearNum, monthNum - 1, 1);
    const endDate   = new Date(yearNum, monthNum, 0); // dernier jour du mois

    const { Op } = require('sequelize');
    const joursFeries = await JoursFeries.findAll({
      where: {
        entreprise_id: entrepriseId,
        [Op.or]: [
          { recurrent: true },  // fériés récurrents toujours inclus
          {
            date: {
              [Op.between]: [
                startDate.toISOString().slice(0, 10),
                endDate.toISOString().slice(0, 10),
              ],
            },
          },
        ],
      },
      order: [['date', 'ASC']],
    });
    res.json(joursFeries);
  } catch (err) {
    next(err);
  }
}

module.exports = {
  getJoursFeriesByMonth,
  listerJoursFeries,
  creerJourFerie,
  getJourFerie,
  updateJourFerie,
  supprimerJourFerie,
  importerJoursFeriesNationaux,
  listerModelesJoursFeries,
  creerModeleJoursFeries,
  exporterModeleJoursFeriesCsv,
  importerModeleJoursFeriesCsv,
  appliquerModeleJoursFeries,
};