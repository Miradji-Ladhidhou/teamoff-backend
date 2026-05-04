const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { parse } = require('csv-parse/sync');
const { Utilisateur, Entreprise, sequelize } = require('../models');
const emailService = require('../services/emailService');
const quotasService = require('../services/quotasService');
const logger = require('../utils/logger');

const ALLOWED_ROLES = ['employe', 'manager', 'admin_entreprise'];
const MAX_ROWS = 200;

function normalizeRow(raw, defaultEntrepriseId) {
  const nom = String(raw.nom || '').trim();
  const prenom = String(raw.prenom || '').trim();
  const email = String(raw.email || '').trim().toLowerCase();
  const role = String(raw.role || 'employe').trim().toLowerCase();
  const service = String(raw.service || '').trim() || null;
  const date_embauche = String(raw.date_embauche || '').trim() || null;
  const entreprise_id = String(raw.entreprise_id || defaultEntrepriseId || '').trim();

  const errors = [];
  if (!nom) errors.push('nom requis');
  if (!prenom) errors.push('prenom requis');
  if (!email || !/\S+@\S+\.\S+/.test(email)) errors.push('email invalide');
  if (!ALLOWED_ROLES.includes(role)) errors.push(`role invalide (${ALLOWED_ROLES.join('/')})`);
  if (!entreprise_id) errors.push('entreprise_id requis');

  return { nom, prenom, email, role, service, date_embauche, entreprise_id, errors };
}

async function importUsersCSV(req, res, next) {
  try {
    if (!req.file?.buffer) {
      return res.status(400).json({ message: 'Fichier CSV manquant' });
    }

    const defaultEntrepriseId = req.user.role !== 'super_admin' ? req.user.entreprise_id : null;

    let rows;
    try {
      rows = parse(req.file.buffer.toString('utf8'), {
        columns: true,
        skip_empty_lines: true,
        trim: true,
      });
    } catch {
      return res.status(400).json({ message: 'Fichier CSV invalide ou mal formaté' });
    }

    if (rows.length === 0) return res.status(400).json({ message: 'Le fichier est vide' });
    if (rows.length > MAX_ROWS) {
      return res.status(400).json({ message: `Maximum ${MAX_ROWS} lignes par import` });
    }

    const normalized = rows.map((raw, i) => ({ line: i + 2, ...normalizeRow(raw, defaultEntrepriseId) }));
    const validationErrors = normalized.filter((r) => r.errors.length > 0)
      .map((r) => ({ line: r.line, errors: r.errors }));

    if (validationErrors.length > 0) {
      return res.status(422).json({ message: 'Erreurs de validation', errors: validationErrors });
    }

    const created = [];
    const skipped = [];

    for (const row of normalized) {
      if (req.user.role === 'admin_entreprise' && row.entreprise_id !== req.user.entreprise_id) {
        skipped.push({ email: row.email, reason: 'entreprise non autorisée' });
        continue;
      }

      const existing = await Utilisateur.findOne({ where: { email: row.email } });
      if (existing) {
        skipped.push({ email: row.email, reason: 'email déjà utilisé' });
        continue;
      }

      const tempPassword = crypto.randomBytes(6).toString('hex').slice(0, 8) + 'A1!';
      const hash = await bcrypt.hash(tempPassword, 10);

      let newUser = null;
      await sequelize.transaction(async (t) => {
        newUser = await Utilisateur.create({
          nom: row.nom,
          prenom: row.prenom,
          email: row.email,
          role: row.role,
          service: row.service,
          entreprise_id: row.entreprise_id,
          date_embauche: row.date_embauche,
          password_hash: hash,
          statut: 'en_attente',
        }, { transaction: t });

        await quotasService.initializeUserCounters({
          entrepriseId: row.entreprise_id,
          utilisateurId: newUser.id,
          annee: new Date().getFullYear(),
          transaction: t,
        });
      });

      const entreprise = await Entreprise.findByPk(row.entreprise_id);
      emailService.sendWelcomeEmail(newUser, entreprise, tempPassword)
        .catch(emailErr => logger.error('Erreur envoi email bienvenue import CSV', { email: newUser.email, error: emailErr.message }));

      created.push({ id: newUser.id, email: newUser.email, nom: newUser.nom, prenom: newUser.prenom });
    }

    const status = created.length > 0 && skipped.length === 0 ? 201 : 200;
    res.status(status).json({
      message: `${created.length} utilisateur(s) créé(s), ${skipped.length} ignoré(s)`,
      created,
      skipped,
    });
  } catch (err) {
    logger.error('Import CSV utilisateurs', { error: err.message });
    next(err);
  }
}

module.exports = { importUsersCSV };
