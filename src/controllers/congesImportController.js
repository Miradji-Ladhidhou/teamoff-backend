'use strict';

const { parse } = require('csv-parse/sync');
const { Utilisateur, Entreprise, CongeType, Conge, CompteurConges, sequelize } = require('../models');
const { calcJoursConges } = require('../services/congesService');
const safeNum = (v) => parseFloat(v || 0);
const logger = require('../utils/logger');

const ALLOWED_STATUTS = ['en_attente_manager', 'valide_manager', 'refuse_manager', 'valide_final', 'refuse_final'];
const MAX_ROWS = 500;

function parseContent(buffer) {
  let content = buffer.toString('utf8');
  if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1);
  const allLines = content.split(/\r?\n/);
  const fromLine = /^sep=/i.test((allLines[0] || '').trim()) ? 2 : 1;
  const headerLine = allLines[fromLine - 1] || '';
  const delimiter = headerLine.includes(';') && !headerLine.includes(',') ? ';' : ',';
  return { content, fromLine, delimiter };
}

function normalizeRow(raw) {
  const email      = String(raw.email      || '').trim().toLowerCase();
  const type_conge = String(raw.type_conge || '').trim();
  const date_debut = String(raw.date_debut || '').trim();
  const date_fin   = String(raw.date_fin   || '').trim();
  const statut     = String(raw.statut     || '').trim() || 'valide_final';
  const commentaire = String(raw.commentaire || '').trim() || null;

  const errors = [];
  if (!email || !/\S+@\S+\.\S+/.test(email)) errors.push('email invalide');
  if (!type_conge) errors.push('type_conge requis');
  if (!date_debut || !/^\d{4}-\d{2}-\d{2}$/.test(date_debut)) errors.push('date_debut invalide (format YYYY-MM-DD)');
  if (!date_fin   || !/^\d{4}-\d{2}-\d{2}$/.test(date_fin))   errors.push('date_fin invalide (format YYYY-MM-DD)');
  if (date_debut && date_fin && !/^\d{4}-\d{2}-\d{2}$/.test(date_debut) === false
      && !/^\d{4}-\d{2}-\d{2}$/.test(date_fin) === false && date_fin < date_debut)
    errors.push('date_fin antérieure à date_debut');
  if (!ALLOWED_STATUTS.includes(statut))
    errors.push(`statut invalide — valeurs acceptées : ${ALLOWED_STATUTS.join(', ')}`);

  return { email, type_conge, date_debut, date_fin, statut, commentaire, errors };
}

async function importCongesCSV(req, res, next) {
  try {
    if (!req.file?.buffer) return res.status(400).json({ message: 'Fichier CSV manquant' });

    const entreprise_id = String(req.body.entreprise_id || '').trim();
    if (!entreprise_id) return res.status(400).json({ message: 'entreprise_id requis' });

    const entreprise = await Entreprise.findByPk(entreprise_id);
    if (!entreprise) return res.status(404).json({ message: 'Entreprise introuvable' });

    let rows;
    try {
      const { content, fromLine, delimiter } = parseContent(req.file.buffer);
      rows = parse(content, { columns: true, skip_empty_lines: true, trim: true, delimiter, from_line: fromLine });
    } catch {
      return res.status(400).json({ message: 'Fichier CSV invalide ou mal formaté' });
    }

    if (rows.length === 0) return res.status(400).json({ message: 'Le fichier est vide' });
    if (rows.length > MAX_ROWS) return res.status(400).json({ message: `Maximum ${MAX_ROWS} lignes par import` });

    const normalized = rows.map((raw, i) => ({ line: i + 2, ...normalizeRow(raw) }));

    // Toutes les erreurs de format en une fois
    const formatErrors = normalized.filter(r => r.errors.length > 0).map(r => ({ line: r.line, errors: r.errors }));
    if (formatErrors.length > 0) return res.status(422).json({ message: 'Erreurs de validation', errors: formatErrors });

    // Charger utilisateurs et types de congé de l'entreprise
    const utilisateurs = await Utilisateur.findAll({ where: { entreprise_id }, attributes: ['id', 'email'] });
    const userByEmail = new Map(utilisateurs.map(u => [u.email.toLowerCase(), u]));

    const congeTypes = await CongeType.findAll({ where: { entreprise_id } });
    const typeByLibelle = new Map(congeTypes.map(t => [t.libelle.toLowerCase(), t]));

    // Vérifier emails et types inconnus (toutes les erreurs de référence en une fois)
    const refErrors = [
      ...normalized.filter(r => !userByEmail.has(r.email))
        .map(r => ({ line: r.line, errors: [`email inconnu dans cette entreprise : "${r.email}"`] })),
      ...normalized.filter(r => r.type_conge && !typeByLibelle.has(r.type_conge.toLowerCase()))
        .map(r => ({ line: r.line, errors: [`type_conge inconnu pour cette entreprise : "${r.type_conge}"`] })),
    ].sort((a, b) => a.line - b.line);
    if (refErrors.length > 0) return res.status(422).json({ message: 'Données inconnues', errors: refErrors });

    const created = [];
    const skipped = [];

    await sequelize.transaction(async (t) => {
      for (const row of normalized) {
        const user      = userByEmail.get(row.email);
        const congeType = typeByLibelle.get(row.type_conge.toLowerCase());

        // Skip si congé identique existe déjà
        const existing = await Conge.findOne({
          where: { entreprise_id, utilisateur_id: user.id, conge_type_id: congeType.id, date_debut: row.date_debut, date_fin: row.date_fin },
          transaction: t,
        });
        if (existing) {
          skipped.push({ line: row.line, email: row.email, raison: 'congé identique déjà existant' });
          continue;
        }

        const jours = await calcJoursConges(entreprise_id, row.date_debut, row.date_fin, 'matin', 'apres_midi', t);

        const conge = await Conge.create({
          entreprise_id,
          utilisateur_id:     user.id,
          conge_type_id:      congeType.id,
          date_debut:         row.date_debut,
          date_fin:           row.date_fin,
          debut_demi_journee: 'matin',
          fin_demi_journee:   'apres_midi',
          statut:             row.statut,
          commentaire_employe: row.commentaire,
          jours_calcules:     jours,
        }, { transaction: t });

        // Mise à jour du CompteurConges selon le statut
        const annee = new Date(row.date_debut).getFullYear();
        const compteur = await CompteurConges.findOne({
          where: { entreprise_id, utilisateur_id: user.id, conge_type_id: congeType.id, annee },
          transaction: t,
        });
        if (compteur) {
          if (row.statut === 'valide_final') {
            compteur.jours_acquis = Math.max(0, safeNum(compteur.jours_acquis) - jours);
            compteur.jours_pris   = safeNum(compteur.jours_pris) + jours;
          } else if (['en_attente_manager', 'valide_manager'].includes(row.statut)) {
            compteur.jours_reserves = safeNum(compteur.jours_reserves) + jours;
          }
          // refuse_final / refuse_manager → solde inchangé
          await compteur.save({ transaction: t });
        }

        created.push({
          id: conge.id, email: row.email, type_conge: row.type_conge,
          date_debut: row.date_debut, date_fin: row.date_fin,
          jours_calcules: jours, statut: row.statut,
        });
      }
    });

    res.status(created.length > 0 ? 201 : 200).json({
      message: `${created.length} congé(s) créé(s), ${skipped.length} ignoré(s)`,
      created,
      skipped,
    });
  } catch (err) {
    logger.error('Import CSV congés', { error: err.message });
    next(err);
  }
}

async function getCongesImportTemplate(req, res, next) {
  try {
    const entreprise_id = String(req.query.entreprise_id || '').trim();
    if (!entreprise_id) return res.status(400).json({ message: 'entreprise_id requis' });

    const congeTypes = await CongeType.findAll({ where: { entreprise_id } });

    const csvField = (v) => (v.includes(',') || v.includes('"') || v.includes('\n'))
      ? `"${v.replace(/"/g, '""')}"` : v;

    const lines = ['email,type_conge,date_debut,date_fin,statut,commentaire'];
    const exempleStatuts = ['valide_final', 'refuse_final', 'en_attente_manager'];

    if (congeTypes.length === 0) {
      lines.push('marie.dupont@exemple.fr,Congés payés,2026-01-06,2026-01-10,valide_final,Congé annuel');
    } else {
      congeTypes.forEach((ct, i) => {
        const statut = exempleStatuts[i % exempleStatuts.length];
        lines.push(`marie.dupont@exemple.fr,${csvField(ct.libelle)},2026-01-06,2026-01-10,${statut},Congé annuel`);
      });
    }

    const csv = ['sep=,', ...lines].join('\r\n') + '\r\n';
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', 'attachment; filename="modele_import_conges.csv"');
    res.send(Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(csv, 'utf8')]));
  } catch (err) {
    logger.error('Template CSV congés', { error: err.message });
    next(err);
  }
}

module.exports = { importCongesCSV, getCongesImportTemplate };
