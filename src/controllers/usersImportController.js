const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { parse } = require('csv-parse/sync');
const { Utilisateur, Entreprise, CongeType, CompteurConges, sequelize } = require('../models');
const emailService = require('../services/emailService');
const quotasService = require('../services/quotasService');
const logger = require('../utils/logger');
const { BCRYPT_COST } = require('../services/authService');

const ALLOWED_ROLES = ['employe', 'manager', 'admin_entreprise'];
const MAX_ROWS = 300;

function normalizeRow(raw) {
  const nom = String(raw.nom || '').trim();
  const prenom = String(raw.prenom || '').trim();
  const email = String(raw.email || '').trim().toLowerCase();
  const role = String(raw.role || 'employe').trim().toLowerCase();
  const service = String(raw.service || '').trim() || null;
  const date_embauche = String(raw.date_embauche || '').trim() || null;
  const type_conge = String(raw.type_conge || '').trim() || null;
  const jours_acquis = (raw.jours_acquis !== undefined && raw.jours_acquis !== '')
    ? parseFloat(raw.jours_acquis) : null;
  const jours_pris = (raw.jours_pris !== undefined && raw.jours_pris !== '')
    ? parseFloat(raw.jours_pris) : null;

  const errors = [];
  if (!nom) errors.push('nom requis');
  if (!prenom) errors.push('prenom requis');
  if (!email || !/\S+@\S+\.\S+/.test(email)) errors.push('email invalide');
  if (!ALLOWED_ROLES.includes(role)) errors.push(`role invalide (${ALLOWED_ROLES.join('/')})`);
  if (date_embauche && !/^\d{4}-\d{2}-\d{2}$/.test(date_embauche)) errors.push('date_embauche invalide (format YYYY-MM-DD)');
  if (type_conge) {
    if (jours_acquis === null || isNaN(jours_acquis) || jours_acquis < 0) errors.push('jours_acquis invalide (≥ 0 requis)');
    if (jours_pris === null || isNaN(jours_pris) || jours_pris < 0) errors.push('jours_pris invalide (≥ 0 requis)');
    if (!isNaN(jours_acquis) && !isNaN(jours_pris) && jours_pris > jours_acquis) errors.push('jours_pris supérieur à jours_acquis');
  }

  return { nom, prenom, email, role, service, date_embauche, type_conge, jours_acquis, jours_pris, errors };
}

async function importUsersCSV(req, res, next) {
  try {
    if (!req.file?.buffer) return res.status(400).json({ message: 'Fichier CSV manquant' });

    const entreprise_id = String(req.body.entreprise_id || '').trim();
    if (!entreprise_id) return res.status(400).json({ message: 'entreprise_id requis' });

    const entreprise = await Entreprise.findByPk(entreprise_id);
    if (!entreprise) return res.status(404).json({ message: 'Entreprise introuvable' });

    let rows;
    try {
      rows = parse(req.file.buffer.toString('utf8'), { columns: true, skip_empty_lines: true, trim: true });
    } catch {
      return res.status(400).json({ message: 'Fichier CSV invalide ou mal formaté' });
    }

    if (rows.length === 0) return res.status(400).json({ message: 'Le fichier est vide' });
    if (rows.length > MAX_ROWS) return res.status(400).json({ message: `Maximum ${MAX_ROWS} lignes par import` });

    const normalized = rows.map((raw, i) => ({ line: i + 2, ...normalizeRow(raw) }));

    // Validation structurelle (toutes les erreurs d'un coup)
    const validationErrors = normalized.filter(r => r.errors.length > 0).map(r => ({ line: r.line, errors: r.errors }));
    if (validationErrors.length > 0) return res.status(422).json({ message: 'Erreurs de validation', errors: validationErrors });

    // Doublon email + type_conge dans le fichier
    const balanceKeys = new Set();
    for (const row of normalized) {
      if (!row.type_conge) continue;
      const key = `${row.email}|${row.type_conge.toLowerCase()}`;
      if (balanceKeys.has(key)) {
        return res.status(422).json({
          message: 'Erreurs de validation',
          errors: [{ line: row.line, errors: [`doublon email + type_conge : "${row.email}" / "${row.type_conge}"`] }],
        });
      }
      balanceKeys.add(key);
    }

    // Charger les types de congé de l'entreprise et valider les libellés
    const congeTypes = await CongeType.findAll({ where: { entreprise_id } });
    const typeByLibelle = new Map(congeTypes.map(t => [t.libelle.toLowerCase(), t]));

    const unknownTypes = normalized
      .filter(r => r.type_conge && !typeByLibelle.has(r.type_conge.toLowerCase()))
      .map(r => ({ line: r.line, errors: [`type_conge inconnu pour cette entreprise : "${r.type_conge}"`] }));
    if (unknownTypes.length > 0) return res.status(422).json({ message: 'Types de congé inconnus', errors: unknownTypes });

    // Dédoublonnage des employés par email (première occurrence = référence)
    const emailToInfo = new Map();
    for (const row of normalized) {
      if (!emailToInfo.has(row.email)) {
        emailToInfo.set(row.email, { nom: row.nom, prenom: row.prenom, email: row.email, role: row.role, service: row.service, date_embauche: row.date_embauche });
      }
    }

    // Pré-calcul des mots de passe hors transaction (bcrypt est CPU-intensif, pas de hold de connexion DB)
    // On génère pour TOUS les emails : si l'utilisateur existe déjà à l'intérieur de la transaction,
    // le mot de passe sera simplement ignoré — ce qui évite un crash si un utilisateur est créé/supprimé
    // entre ce point et le début de la transaction.
    const newUserPasswords = new Map();
    for (const [email] of emailToInfo) {
      const tempPassword = crypto.randomBytes(6).toString('hex').slice(0, 8) + 'A1!';
      const hash = await bcrypt.hash(tempPassword, BCRYPT_COST);
      newUserPasswords.set(email, { tempPassword, hash });
    }

    const annee = new Date().getFullYear();
    const created = [];
    const skipped = [];
    const balancesSet = [];
    const usersToNotify = [];

    await sequelize.transaction(async (t) => {
      const userByEmail = new Map();

      // Étape 1 : créer ou récupérer les utilisateurs
      for (const [email, info] of emailToInfo) {
        let user = await Utilisateur.findOne({ where: { email }, transaction: t });

        if (user) {
          if (user.entreprise_id !== entreprise_id) {
            skipped.push({ email, reason: 'utilisateur appartient à une autre entreprise' });
          } else {
            skipped.push({ email, reason: 'email déjà utilisé (soldes mis à jour)' });
            userByEmail.set(email, user);
          }
          continue;
        }

        const { tempPassword, hash } = newUserPasswords.get(email);
        user = await Utilisateur.create({
          nom: info.nom,
          prenom: info.prenom,
          email: info.email,
          role: info.role,
          service: info.service,
          entreprise_id,
          date_embauche: info.date_embauche,
          password_hash: hash,
          statut: 'en_attente',
        }, { transaction: t });

        await quotasService.initializeUserCounters({ entrepriseId: entreprise_id, utilisateurId: user.id, annee, transaction: t });
        created.push({ id: user.id, email: user.email, nom: user.nom, prenom: user.prenom });
        usersToNotify.push({ user, tempPassword });
        userByEmail.set(email, user);
      }

      // Étape 2 : poser les soldes pour toutes les lignes avec type_conge
      for (const row of normalized) {
        if (!row.type_conge) continue;
        const user = userByEmail.get(row.email);
        if (!user) continue;
        const congeType = typeByLibelle.get(row.type_conge.toLowerCase());

        const [counter] = await CompteurConges.findOrCreate({
          where: { entreprise_id, utilisateur_id: user.id, conge_type_id: congeType.id, annee },
          defaults: { jours_acquis: 0, jours_pris: 0, jours_reserves: 0, jours_reportes: 0, jours_annules: 0 },
          transaction: t,
        });

        await counter.update({ jours_acquis: row.jours_acquis, jours_pris: row.jours_pris }, { transaction: t });
        balancesSet.push({ email: row.email, type_conge: row.type_conge, jours_acquis: row.jours_acquis, jours_pris: row.jours_pris });
      }
    });

    // Emails de bienvenue hors transaction (fire & forget)
    for (const { user, tempPassword } of usersToNotify) {
      emailService.sendWelcomeEmail(user, entreprise, tempPassword)
        .catch(e => logger.error('Erreur email bienvenue import CSV', { email: user.email, error: e.message }));
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

    const congeTypes = await CongeType.findAll({ where: { entreprise_id } });
    const lines = ['nom,prenom,email,role,service,date_embauche,type_conge,jours_acquis,jours_pris'];

    const csvField = (v) => (v.includes(',') || v.includes('"') || v.includes('\n'))
      ? `"${v.replace(/"/g, '""')}"` : v;

    if (congeTypes.length === 0) {
      lines.push('Dupont,Marie,marie.dupont@exemple.fr,employe,RH,2021-03-01,,0,0');
    } else {
      for (const ct of congeTypes) {
        lines.push(`Dupont,Marie,marie.dupont@exemple.fr,employe,RH,2021-03-01,${csvField(ct.libelle)},0,0`);
      }
    }

    const csv = lines.join('\n') + '\n';
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', 'attachment; filename="modele_import_employes.csv"');
    res.send(csv);
  } catch (err) {
    logger.error('Template CSV employés', { error: err.message });
    next(err);
  }
}

module.exports = { importUsersCSV, getImportTemplate };
