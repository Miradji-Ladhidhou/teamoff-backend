// controllers/joursFeriesController.js
const { JoursFeries, HolidayTemplate, HolidayTemplateItem, sequelize } = require('../models');
const { Op } = require('sequelize');
const { auditFerie } = require('../services/auditHelper');
const { Parser } = require('json2csv');

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

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

// Cap défensif : le volume par entreprise est structurellement borné par la
// contrainte unique (entreprise_id, date) ≈ 1 ligne/jour max, mais un import
// pathologique sur N années pourrait dépasser quelques centaines de lignes.
// 500 couvre largement 10 ans × 50 fériés/an sans casser le frontend.
const JOURS_FERIES_MAX = 500;

// ----------------------------
// Lister tous les jours fériés
// ----------------------------
async function listerJoursFeries(req, res, next) {
  try {
    const entrepriseId = getTargetEntrepriseId(req);
    if (!entrepriseId) {
      return res.status(400).json({ message: 'entreprise_id est requis pour ce profil.' });
    }

    const where = { entreprise_id: entrepriseId };

    // Filtre optionnel par année — les récurrents sont toujours inclus (ils s'appliquent à toutes les années)
    const rawYear = req.query.year;
    if (rawYear !== undefined) {
      const year = parseInt(rawYear, 10);
      if (!Number.isInteger(year) || year < 2000 || year > 2100) {
        return res.status(400).json({ message: 'Paramètre year invalide (entier entre 2000 et 2100)' });
      }
      const start = `${year}-01-01`;
      const end   = `${year}-12-31`;
      where[Op.or] = [
        { recurrent: true },
        { date: { [Op.between]: [start, end] } },
      ];
    }

    const joursFeries = await JoursFeries.findAll({
      where,
      order: [['date', 'ASC']],
      limit: JOURS_FERIES_MAX,
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

    if (!date || !DATE_REGEX.test(date) || isNaN(new Date(date).getTime())) {
      await t.rollback();
      return res.status(400).json({ message: 'Le champ date est requis et doit être au format YYYY-MM-DD valide' });
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

    if (!date || !DATE_REGEX.test(date) || isNaN(new Date(date).getTime())) {
      await t.rollback();
      return res.status(400).json({ message: 'Le champ date est requis et doit être au format YYYY-MM-DD valide' });
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

    const COUNTRY_CODE_RE = /^[A-Z]{2,3}$/;
    if (!COUNTRY_CODE_RE.test(countryCode)) {
      await t.rollback();
      return res.status(400).json({ message: 'Code pays invalide (2-3 lettres ISO attendu).' });
    }

    const nagerBase = process.env.NAGER_API_URL || 'https://date.nager.at/api/v3';
    const response = await fetch(`${nagerBase}/PublicHolidays/${year}/${countryCode}`);
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
        date: { [Op.in]: dates },
      },
      transaction: t,
    });

    const existingDates = new Set(existing.map((e) => e.date));
    // Index des entrées existantes pour mise à jour rétroactive du flag recurrent
    const existingByDate = Object.fromEntries(existing.map((e) => [e.date, e]));

    // Les récurrents couvrent déjà leur mois+jour sur toutes les années → éviter les doublons
    const recurrentJours = await JoursFeries.findAll({
      where: { entreprise_id: entrepriseId, recurrent: true },
      attributes: ['date'],
      transaction: t,
    });
    const recurrentMonthDays = new Set(recurrentJours.map((jf) => String(jf.date).slice(5)));

    // Séparer nouvelles entrées et corrections rétroactives
    const toCreate = [];
    let updatedRecurrent = 0;

    for (const h of apiHolidays) {
      if (!h?.date) continue;

      // h.fixed = true → date fixe chaque année (Noël, Jour de l'An…)
      // h.fixed = false → date mobile (Pâques, Pentecôte…)
      const isFixed = h.fixed === true;
      const monthDay = h.date.slice(5);

      if (existingDates.has(h.date)) {
        // Entrée déjà en base : corriger rétroactivement recurrent si h.fixed et pas encore marquée
        const entry = existingByDate[h.date];
        if (isFixed && entry && !entry.recurrent) {
          await entry.update({ recurrent: true }, { transaction: t });
          recurrentMonthDays.add(monthDay);
          updatedRecurrent += 1;
        }
        continue;
      }

      // Ignorer si un récurrent couvre déjà ce mois+jour (sauf si on vient juste de mettre à jour)
      if (recurrentMonthDays.has(monthDay)) continue;

      toCreate.push({
        entreprise_id: entrepriseId,
        date: h.date,
        libelle: h.localName || h.name || `Jour férié ${h.date}`,
        recurrent: isFixed,
        est_travail: false,
      });

      // Si ce nouveau férié est récurrent, l'ajouter au set pour les suivants dans la même boucle
      if (isFixed) recurrentMonthDays.add(monthDay);
    }

    if (toCreate.length > 0) {
      await JoursFeries.bulkCreate(toCreate, { transaction: t });
    }

    await t.commit();

    const skippedTotal = apiHolidays.filter((h) => h?.date).length - toCreate.length - updatedRecurrent;

    return res.json({
      message: 'Import des jours fériés terminé.',
      imported: toCreate.length,
      updated_recurrent: updatedRecurrent,
      skipped: skippedTotal,
      total: apiHolidays.filter((h) => h?.date).length,
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

    // Isolation par entreprise : un admin_entreprise ne voit que ses propres
    // templates + les templates globaux (source_entreprise_id null).
    // Le super_admin voit tout.
    if (req.user?.role !== 'super_admin') {
      const entrepriseId = req.user?.entreprise_id || null;
      where[Op.or] = [
        { source_entreprise_id: entrepriseId },
        { source_entreprise_id: null },
      ];
    }

    if (region) {
      where.region = region;
    }
    if (search) {
      where[Op.and] = [
        ...(where[Op.and] || []),
        {
          [Op.or]: [
            { name: { [Op.iLike]: `%${search}%` } },
            { region: { [Op.iLike]: `%${search}%` } },
          ],
        },
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

    // C-4: IDOR — un admin_entreprise ne peut appliquer que des templates globaux
    // (source_entreprise_id null) ou ses propres templates
    if (req.user?.role !== 'super_admin') {
      if (template.source_entreprise_id !== null &&
          template.source_entreprise_id !== req.user?.entreprise_id) {
        await t.rollback();
        return res.status(403).json({ message: 'Accès interdit à ce modèle.' });
      }
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

    const startDate = new Date(Date.UTC(yearNum, monthNum - 1, 1));
    const endDate   = new Date(Date.UTC(yearNum, monthNum, 0));

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

// ----------------------------
// Réparation rétroactive du flag recurrent
// ----------------------------
async function repairerRecurrence(req, res, next) {
  try {
    const entrepriseId = getTargetEntrepriseId(req, { allowBody: true });
    if (!entrepriseId) {
      return res.status(400).json({ message: 'entreprise_id requis.' });
    }

    const countryCode = String(req.query.country || req.body?.country || 'FR').toUpperCase();

    const allJoursFeries = await JoursFeries.findAll({
      where: { entreprise_id: entrepriseId },
      attributes: ['id', 'date', 'recurrent'],
    });

    if (allJoursFeries.length === 0) {
      return res.json({ message: 'Aucun jour férié à corriger.', fixed: 0 });
    }

    // Étape 1 : heuristique — même MM-DD dans 2+ années différentes → férié fixe
    const groups = {};
    for (const jf of allJoursFeries) {
      const md = String(jf.date).slice(5, 10); // "MM-DD"
      if (!groups[md]) groups[md] = [];
      groups[md].push(jf);
    }

    const toUpdate = new Set();
    for (const entries of Object.values(groups)) {
      const years = new Set(entries.map((e) => String(e.date).slice(0, 4)));
      if (years.size >= 2) {
        entries.filter((e) => !e.recurrent).forEach((e) => toUpdate.add(e.id));
      }
    }

    // Étape 2 : pour chaque année présente en base, interroger Nager API et appliquer h.fixed
    const uniqueYears = [...new Set(allJoursFeries.map((jf) => String(jf.date).slice(0, 4)))].slice(0, 5);
    const nagerBase = process.env.NAGER_API_URL || 'https://date.nager.at/api/v3';

    for (const year of uniqueYears) {
      try {
        const resp = await fetch(`${nagerBase}/PublicHolidays/${year}/${countryCode}`);
        if (!resp.ok) continue;
        const holidays = await resp.json();
        if (!Array.isArray(holidays)) continue;

        for (const h of holidays) {
          if (!h?.date || h.fixed !== true) continue;
          const match = allJoursFeries.find((jf) => String(jf.date).startsWith(h.date));
          if (match && !match.recurrent) toUpdate.add(match.id);
        }
      } catch { /* ignore erreurs réseau pour cette année */ }
    }

    let fixed = 0;
    if (toUpdate.size > 0) {
      await JoursFeries.update(
        { recurrent: true },
        { where: { id: { [Op.in]: [...toUpdate] } } }
      );
      fixed = toUpdate.size;
    }

    return res.json({
      message: fixed > 0
        ? `${fixed} jour(s) férié(s) marqué(s) comme récurrent(s).`
        : 'Aucune correction nécessaire — tous les fériés à date fixe sont déjà récurrents.',
      fixed,
    });
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
  repairerRecurrence,
  listerModelesJoursFeries,
  creerModeleJoursFeries,
  exporterModeleJoursFeriesCsv,
  importerModeleJoursFeriesCsv,
  appliquerModeleJoursFeries,
};