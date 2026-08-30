'use strict';

const crypto = require('crypto');
const jwt    = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const { parse } = require('csv-parse/sync');
const { Utilisateur, Entreprise, CongeType, CompteurConges, sequelize } = require('../models');
const emailService = require('../services/emailService');
const quotasService = require('../services/quotasService');
const logger = require('../utils/logger');

const BCRYPT_COST = 12;

const ALLOWED_ROLES = ['employe', 'apprenti', 'manager', 'admin_entreprise'];
const MAX_ROWS = 300;

// Détecte les colonnes de solde dans les en-têtes CSV.
// Format attendu : "{libelle du type} (N)" et "{libelle du type} (N-1)"
function detectBalanceColumns(headers, congeTypes, currentYear) {
  const typeByNorm = new Map(congeTypes.map(t => [t.libelle.trim().toLowerCase(), t]));
  const cols = [];
  for (const header of headers) {
    const mN  = header.match(/^(.+)\s+\(N\)$/i);
    const mN1 = header.match(/^(.+)\s+\(N-1\)$/i);
    if (mN) {
      const ct = typeByNorm.get(mN[1].trim().toLowerCase());
      if (ct) cols.push({ header, congeTypeId: ct.id, annee: currentYear });
    } else if (mN1) {
      const ct = typeByNorm.get(mN1[1].trim().toLowerCase());
      if (ct) cols.push({ header, congeTypeId: ct.id, annee: currentYear - 1 });
    }
  }
  return cols;
}

function normalizeRow(raw, balanceCols) {
  const nom           = String(raw.nom           || '').trim();
  const prenom        = String(raw.prenom        || '').trim();
  const email         = String(raw.email         || '').trim().toLowerCase();
  const role          = String(raw.role          || 'employe').trim().toLowerCase();
  const service       = String(raw.service       || '').trim() || null;
  const date_embauche = String(raw.date_embauche || '').trim() || null;

  const errors = [];
  if (!nom)    errors.push('nom requis');
  if (!prenom) errors.push('prenom requis');
  if (!email || !/\S+@\S+\.\S+/.test(email)) errors.push('email invalide');
  if (!ALLOWED_ROLES.includes(role)) errors.push(`role invalide (${ALLOWED_ROLES.join('/')})`);
  if (date_embauche && !/^\d{4}-\d{2}-\d{2}$/.test(date_embauche))
    errors.push('date_embauche invalide (format YYYY-MM-DD)');

  const balances = [];
  for (const col of balanceCols) {
    const raw_val = raw[col.header];
    if (raw_val === undefined || raw_val === '') continue; // colonne optionnelle
    const val = parseFloat(String(raw_val).replace(',', '.'));
    if (isNaN(val) || val < 0) {
      errors.push(`"${col.header}" : nombre ≥ 0 requis`);
    } else {
      balances.push({ congeTypeId: col.congeTypeId, annee: col.annee, jours_acquis: val });
    }
  }

  return { nom, prenom, email, role, service, date_embauche, balances, errors };
}

function parseContent(buffer) {
  let content = buffer.toString('utf8');
  if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1);
  const allLines = content.split(/\r?\n/);
  const fromLine = /^sep=/i.test((allLines[0] || '').trim()) ? 2 : 1;
  const headerLine = allLines[fromLine - 1] || '';
  const delimiter = headerLine.includes(';') && !headerLine.includes(',') ? ';' : ',';
  return { content, fromLine, delimiter };
}

async function importUsersCSV(req, res, next) {
  try {
    if (!req.file?.buffer) return res.status(400).json({ message: 'Fichier CSV manquant' });

    const entreprise_id = String(req.body.entreprise_id || '').trim();
    if (!entreprise_id) return res.status(400).json({ message: 'entreprise_id requis' });
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(entreprise_id))
      return res.status(400).json({ message: 'entreprise_id invalide (UUID attendu)' });

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

    const currentYear = new Date().getFullYear();
    const congeTypes  = await CongeType.findAll({ where: { entreprise_id } });

    // Détecter les colonnes de solde depuis les en-têtes du fichier
    const headers     = Object.keys(rows[0]);
    const balanceCols = detectBalanceColumns(headers, congeTypes, currentYear);

    const normalized = rows.map((raw, i) => ({ line: i + 2, ...normalizeRow(raw, balanceCols) }));

    // Toutes les erreurs de format en une fois
    const validationErrors = normalized
      .filter(r => r.errors.length > 0)
      .map(r => ({ line: r.line, errors: r.errors }));
    if (validationErrors.length > 0)
      return res.status(422).json({ message: 'Erreurs de validation', errors: validationErrors });

    // Doublon email dans le fichier
    const emailsSeen = new Set();
    for (const row of normalized) {
      if (emailsSeen.has(row.email)) {
        return res.status(422).json({
          message: 'Erreurs de validation',
          errors: [{ line: row.line, errors: [`email en doublon dans le fichier : "${row.email}"`] }],
        });
      }
      emailsSeen.add(row.email);
    }

    // Pré-calcul des tokens d'invitation hors transaction
    // Un seul placeholder hash partagé : satisfait la contrainte NOT NULL ; l'utilisateur
    // ne peut pas se connecter tant que statut='en_attente' et qu'il n'a pas défini son mot de passe.
    const placeholderHash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), BCRYPT_COST);
    const inviteTokens = new Map();
    for (const row of normalized) {
      const inviteToken = jwt.sign(
        { email: row.email, type: 'set_password' },
        process.env.JWT_SECRET,
        { expiresIn: '48h' }
      );
      const inviteHash = crypto.createHash('sha256').update(inviteToken).digest('hex');
      inviteTokens.set(row.email, { inviteToken, inviteHash });
    }

    const created = [];
    const skipped = [];
    const balancesSet = [];
    const usersToNotify = [];

    await sequelize.transaction(async (t) => {
      for (const row of normalized) {
        let user = await Utilisateur.findOne({ where: { email: row.email }, transaction: t });

        if (user) {
          if (user.entreprise_id !== entreprise_id) {
            skipped.push({ email: row.email, reason: 'appartient à une autre entreprise' });
            continue;
          }
          skipped.push({ email: row.email, reason: 'email déjà utilisé (soldes mis à jour)' });
        } else {
          const { inviteHash } = inviteTokens.get(row.email);
          user = await Utilisateur.create({
            nom:               row.nom,
            prenom:            row.prenom,
            email:             row.email,
            role:              row.role,
            service:           row.service,
            entreprise_id,
            date_embauche:     row.date_embauche,
            password_hash:     placeholderHash,
            invite_token_hash: inviteHash,
            statut:            'en_attente',
          }, { transaction: t });

          await quotasService.initializeUserCounters({
            entrepriseId: entreprise_id,
            utilisateurId: user.id,
            annee: currentYear,
            transaction: t,
          });
          created.push({ id: user.id, email: user.email, nom: user.nom, prenom: user.prenom });
          usersToNotify.push({ user, inviteToken: inviteTokens.get(row.email).inviteToken });
        }

        // Poser les soldes pour tous les types × années présents dans le fichier
        for (const bal of row.balances) {
          const [counter] = await CompteurConges.findOrCreate({
            where: {
              entreprise_id,
              utilisateur_id: user.id,
              conge_type_id:  bal.congeTypeId,
              annee:          bal.annee,
            },
            defaults: { jours_acquis: 0, jours_pris: 0, jours_reserves: 0, jours_reportes: 0, jours_annules: 0 },
            transaction: t,
          });
          await counter.update({ jours_acquis: bal.jours_acquis }, { transaction: t });
          balancesSet.push({ email: row.email, annee: bal.annee, jours_acquis: bal.jours_acquis });
        }
      }
    });

    // Emails d'invitation hors transaction — lien valide 48h pour définir le mot de passe
    for (const { user, inviteToken } of usersToNotify) {
      emailService.sendSetPasswordEmail(user, entreprise, inviteToken)
        .catch(e => logger.error('Erreur email invitation import CSV', { email: user.email, error: e.message }));
    }

    res.status(created.length > 0 ? 201 : 200).json({
      message: `${created.length} employé(s) créé(s), ${skipped.length} ignoré(s), ${balancesSet.length} solde(s) mis à jour`,
      created,
      skipped,
      balancesSet,
    });
  } catch (err) {
    logger.error('Import CSV utilisateurs', { error: err.message });
    next(err);
  }
}

async function getImportTemplate(req, res, next) {
  try {
    const entreprise_id = String(req.query.entreprise_id || '').trim();
    if (!entreprise_id) return res.status(400).json({ message: 'entreprise_id requis' });
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(entreprise_id))
      return res.status(400).json({ message: 'entreprise_id invalide (UUID attendu)' });

    const congeTypes  = await CongeType.findAll({ where: { entreprise_id } });
    const currentYear = new Date().getFullYear();

    const csvField = (v) =>
      (v.includes(',') || v.includes(';') || v.includes('"') || v.includes('\n'))
        ? `"${v.replace(/"/g, '""')}"` : v;

    // Colonnes : base + une paire (N-1)/(N) par type de congé
    const balanceCols = congeTypes.flatMap(ct => [
      `${ct.libelle} (N-1)`,
      `${ct.libelle} (N)`,
    ]);
    const headerCols = ['nom', 'prenom', 'email', 'role', 'service', 'date_embauche', ...balanceCols];
    const header = headerCols.map(csvField).join(',');

    // Ligne d'exemple : 0 pour N-1, 25 pour N sur chaque type
    const exBalances = congeTypes.flatMap(() => ['0', '25']);
    const exRow = ['Dupont', 'Marie', 'marie.dupont@exemple.fr', 'employe', 'RH',
      `${currentYear - 3}-03-01`, ...exBalances].map(csvField).join(',');

    const csv = ['sep=,', header, exRow].join('\r\n') + '\r\n';
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', 'attachment; filename="modele_import_employes.csv"');
    res.send(Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(csv, 'utf8')]));
  } catch (err) {
    logger.error('Template CSV employés', { error: err.message });
    next(err);
  }
}

module.exports = { importUsersCSV, getImportTemplate };
