const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { Utilisateur, Entreprise, sequelize } = require('../models');
const emailService = require('../services/emailService');
const { auditUser } = require('../services/auditHelper');
const logger = require('../utils/logger');
const { validatePasswordPolicy } = require('../services/authService');
const quotasService = require('../services/quotasService');

function normalizeServiceName(value) {
  return String(value || '').trim();
}

function normalizeOptionalDateOnly(value) {
  if (typeof value === 'undefined') return undefined;
  if (value === null || value === '') return null;

  const raw = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const err = new Error('date_embauche doit être au format YYYY-MM-DD');
    err.status = 400;
    throw err;
  }

  const parsed = new Date(`${raw}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) {
    const err = new Error('date_embauche invalide');
    err.status = 400;
    throw err;
  }

  return raw;
}

async function serviceExistsInEntreprise(entrepriseId, serviceName) {
  const normalizedService = normalizeServiceName(serviceName);
  if (!normalizedService || !entrepriseId) return false;

  const entreprise = await Entreprise.findByPk(entrepriseId, { attributes: ['id', 'politique_conges'] });
  if (!entreprise) return false;

  const policies = entreprise.politique_conges?.service_policies || {};
  return Object.keys(policies).some((name) => name.toLowerCase() === normalizedService.toLowerCase());
}

async function applyOwnProfileFields(utilisateur, { nom, prenom, email }) {
  if (nom !== undefined) utilisateur.nom = nom;
  if (prenom !== undefined) utilisateur.prenom = prenom;
  if (email !== undefined) {
    const normalized = String(email).trim().toLowerCase();
    if (normalized !== utilisateur.email) {
      const existing = await Utilisateur.findOne({
        where: { entreprise_id: utilisateur.entreprise_id, email: normalized },
      });
      if (existing) {
        const err = new Error('Cette adresse email est déjà utilisée');
        err.status = 409;
        throw err;
      }
      utilisateur.email = normalized;
    }
  }
}

async function updateOwnPasswordIfRequested(utilisateur, { currentPassword, newPassword, email }) {
  if (!newPassword) return;

  if (!currentPassword) {
    const err = new Error('Le mot de passe actuel est requis pour changer le mot de passe');
    err.status = 400;
    throw err;
  }

  const isCurrentPasswordValid = await bcrypt.compare(currentPassword, utilisateur.password_hash);
  if (!isCurrentPasswordValid) {
    const err = new Error('Le mot de passe actuel est incorrect');
    err.status = 400;
    throw err;
  }

  await validatePasswordPolicy(newPassword);
  utilisateur.password_hash = await bcrypt.hash(newPassword, 10);

  const notificationEmail = email && email !== utilisateur.email ? email : utilisateur.email;
  await emailService.sendPasswordResetConfirmation(notificationEmail);
}

/**
 * Création utilisateur
 */
async function createUser(req, res) {
  const sanitizeHtml = require('sanitize-html');
  let { nom, prenom, email, role, entreprise_id, service, date_embauche } = req.body;
  if (typeof nom === 'string') nom = sanitizeHtml(nom, { allowedTags: [], allowedAttributes: {} });
  if (typeof prenom === 'string') prenom = sanitizeHtml(prenom, { allowedTags: [], allowedAttributes: {} });
  const user = req.user;
  const normalizedService = normalizeServiceName(service);

  if (role === 'employe' && !normalizedService) {
    return res.status(400).json({ message: 'Le service est obligatoire pour un employé' });
  }

  // Vérifications hiérarchiques
  if (user.role === 'admin_entreprise' && !['manager', 'employe'].includes(role)) {
    return res.status(403).json({ message: 'Vous ne pouvez créer que manager ou employe' });
  }
  if (user.role === 'admin_entreprise' && entreprise_id !== user.entreprise_id) {
    return res.status(403).json({ message: 'Vous ne pouvez créer des utilisateurs que dans votre entreprise' });
  }

  try {
    const normalizedHiringDate = normalizeOptionalDateOnly(date_embauche);

    if (normalizedService) {
      const serviceExists = await serviceExistsInEntreprise(entreprise_id, normalizedService);
      if (!serviceExists) {
        return res.status(400).json({ message: 'Service invalide. Sélectionnez un service existant.' });
      }
    }

    // Génère un mot de passe temporaire qui satisfait les politiques les plus strictes
    const base = crypto.randomBytes(6).toString('hex'); // 12 chars lowercase hex
    const tempPassword = base.slice(0, 8) + 'A1!';     // garantit majuscule + chiffre + spécial
    const hash = await bcrypt.hash(tempPassword, 10);

    let newUser = null;

    await sequelize.transaction(async (t) => {
      newUser = await Utilisateur.create({
        nom,
        prenom,
        email,
        role,
        service: normalizedService || null,
        entreprise_id,
        date_embauche: normalizedHiringDate || null,
        password_hash: hash,
        statut: 'en_attente',
      }, { transaction: t });

      await quotasService.initializeUserCounters({
        entrepriseId: entreprise_id,
        utilisateurId: newUser.id,
        annee: new Date().getFullYear(),
        transaction: t,
      });
    });

    const entreprise = entreprise_id
      ? await Entreprise.findByPk(entreprise_id)
      : null;

    // --- Envoi email via EmailService
    await emailService.sendWelcomeEmail(
      newUser,
      entreprise,
      tempPassword
    );

    // === Audit ===
    await auditUser.created(newUser, req.user, req);

    res.status(201).json({
      id: newUser.id,
      nom: newUser.nom,
      prenom: newUser.prenom,
      email: newUser.email,
      role: newUser.role,
      entreprise_id: newUser.entreprise_id,
      date_embauche: newUser.date_embauche,
      statut: newUser.statut,
      message: 'Utilisateur créé et email envoyé avec mot de passe temporaire'
    });
  } catch (err) {
    logger.error('Erreur création utilisateur:', err);
    res.status(err.status || 500).json({ message: 'Erreur serveur', error: err.message });
  }
}

/**
 * Récupération de tous les utilisateurs
 */
async function getAllUsers(req, res) {
  try {
    let where = {};
    if (['admin_entreprise', 'manager'].includes(req.user.role)) {
      where.entreprise_id = req.user.entreprise_id;
    }

    const rawPage = parseInt(req.query.page, 10);
    const rawLimit = parseInt(req.query.limit, 10);
    const paginate = !Number.isNaN(rawPage) && rawPage > 0;

    if (paginate) {
      const page = rawPage;
      const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 200) : 50;
      const offset = (page - 1) * limit;
      const { count, rows } = await Utilisateur.findAndCountAll({
        where,
        order: [['nom', 'ASC']],
        limit,
        offset,
      });
      return res.json({
        items: rows,
        total: count,
        page,
        totalPages: Math.ceil(count / limit),
        limit,
      });
    }

    const users = await Utilisateur.findAll({ where, order: [['nom', 'ASC']] });
    res.json(users);
  } catch (err) {
    logger.error('Erreur récupération utilisateurs:', err);
    res.status(500).json({ message: 'Erreur serveur', error: err.message });
  }
}

/**
 * Récupération utilisateur par ID
 */
async function getUserById(req, res) {
  try {
    const utilisateur = await Utilisateur.findByPk(req.params.id);
    if (!utilisateur) return res.status(404).json({ message: 'Utilisateur introuvable' });

    if (['admin_entreprise', 'manager', 'employe'].includes(req.user.role) &&
        utilisateur.entreprise_id !== req.user.entreprise_id &&
        req.user.role !== 'super_admin') {
      return res.status(403).json({ message: 'Accès interdit : entreprise différente' });
    }

    res.json(utilisateur);
  } catch (err) {
    logger.error('Erreur récupération utilisateur:', err);
    res.status(500).json({ message: 'Erreur serveur', error: err.message });
  }
}

/**
 * Mise à jour utilisateur
 */
async function updateUser(req, res) {
  try {
    const utilisateur = await Utilisateur.findByPk(req.params.id);
    if (!utilisateur) return res.status(404).json({ message: 'Utilisateur introuvable' });

    if (req.user.role === 'admin_entreprise' && utilisateur.entreprise_id !== req.user.entreprise_id) {
      return res.status(403).json({ message: 'Vous ne pouvez modifier que les utilisateurs de votre entreprise' });
    }

    let { nom, prenom, email, role, service, statut, password, date_embauche } = req.body;

    if (email !== undefined) {
      const normalized = String(email).trim().toLowerCase();
      if (normalized !== utilisateur.email) {
        const existing = await Utilisateur.findOne({
          where: { entreprise_id: utilisateur.entreprise_id, email: normalized },
        });
        if (existing) return res.status(409).json({ message: 'Cette adresse email est déjà utilisée' });
        email = normalized;
      }
    }
    if (typeof nom === 'string') nom = require('sanitize-html')(nom, { allowedTags: [], allowedAttributes: {} });
    if (typeof prenom === 'string') prenom = require('sanitize-html')(prenom, { allowedTags: [], allowedAttributes: {} });
    const normalizedHiringDate = normalizeOptionalDateOnly(date_embauche);

    const nextRole = role || utilisateur.role;
    const nextService = typeof service !== 'undefined' ? service : utilisateur.service;
    const normalizedNextService = normalizeServiceName(nextService);

    if (nextRole === 'employe' && !normalizedNextService) {
      return res.status(400).json({ message: 'Le service est obligatoire pour un employé' });
    }

    if (typeof service !== 'undefined' && normalizedNextService) {
      const serviceExists = await serviceExistsInEntreprise(utilisateur.entreprise_id, normalizedNextService);
      if (!serviceExists) {
        return res.status(400).json({ message: 'Service invalide. Sélectionnez un service existant.' });
      }
    }

    if (req.user.role === 'admin_entreprise' && role && !['manager', 'employe'].includes(role)) {
      return res.status(403).json({ message: 'Vous ne pouvez attribuer que manager ou employe' });
    }

    const oldData = utilisateur.toJSON();

    if (password) {
      await validatePasswordPolicy(password);
      utilisateur.password_hash = await bcrypt.hash(password, 10);
      // --- Envoi email de changement de mot de passe
      await emailService.sendPasswordResetConfirmation(email);
    }

    const updatePayload = {
      nom,
      prenom,
      email,
      role,
      service: normalizedNextService || null,
      statut,
    };

    if (typeof date_embauche !== 'undefined') {
      updatePayload.date_embauche = normalizedHiringDate;
    }

    await utilisateur.update(updatePayload);

    // === Audit général ===
    await auditUser.updated(utilisateur, req.user, req);

    // === Audit spécifique changement de rôle ===
    if (role && role !== oldData.role) {
      await auditUser.roleChanged(utilisateur, oldData.role, role, req.user, req);
    }

    res.json(utilisateur);
  } catch (err) {
    logger.error('Erreur mise à jour utilisateur:', err);
    res.status(err.status || 500).json({ message: 'Erreur serveur', error: err.message });
  }
}

/**
 * Changement de rôle utilisateur
 */
async function changeUserRole(req, res) {
  try {
    const utilisateur = await Utilisateur.findByPk(req.params.id);
    if (!utilisateur) return res.status(404).json({ message: 'Utilisateur introuvable' });

    if (req.user.role === 'admin_entreprise' && utilisateur.entreprise_id !== req.user.entreprise_id) {
      return res.status(403).json({ message: 'Vous ne pouvez modifier que les utilisateurs de votre entreprise' });
    }

    const { role } = req.body;

    if (req.user.role === 'admin_entreprise' && role && !['manager', 'employe'].includes(role)) {
      return res.status(403).json({ message: 'Vous ne pouvez attribuer que manager ou employe' });
    }

    const oldRole = utilisateur.role;
    await utilisateur.update({ role });

    // === Audit spécifique changement de rôle ===
    if (role !== oldRole) {
      await auditUser.roleChanged(utilisateur, oldRole, role, req.user, req);
    }

    res.json(utilisateur);
  } catch (err) {
    logger.error('Erreur changement de rôle utilisateur:', err);
    res.status(500).json({ message: 'Erreur serveur', error: err.message });
  }
}

/**
 * Suppression utilisateur
 */
async function deleteUser(req, res) {
  try {
    const utilisateur = await Utilisateur.findByPk(req.params.id);
    if (!utilisateur) return res.status(404).json({ message: 'Utilisateur introuvable' });

    if (req.user.role === 'admin_entreprise' && utilisateur.entreprise_id !== req.user.entreprise_id) {
      return res.status(403).json({ message: 'Vous ne pouvez supprimer que les utilisateurs de votre entreprise' });
    }

    if (utilisateur.id === req.user.id) {
      return res.status(403).json({ message: 'Vous ne pouvez pas supprimer votre propre compte' });
    }

    if (utilisateur.role === 'admin_entreprise') {
      const remainingAdmins = await Utilisateur.count({
        where: { entreprise_id: utilisateur.entreprise_id, role: 'admin_entreprise', id: { [require('sequelize').Op.ne]: utilisateur.id } },
      });
      if (remainingAdmins === 0) {
        return res.status(403).json({ message: 'Impossible de supprimer le dernier administrateur de l\'entreprise' });
      }
    }

    await utilisateur.destroy();

    // === Audit ===
    await auditUser.deleted(utilisateur, req.user, req);

    res.json({ message: 'Utilisateur supprimé avec succès' });
  } catch (err) {
    logger.error('Erreur suppression utilisateur:', err);
    res.status(500).json({ message: 'Erreur serveur', error: err.message });
  }
}


/**
 * Mise à jour du propre profil utilisateur
 */
async function updateOwnProfile(req, res) {
  try {
    const utilisateur = await Utilisateur.findByPk(req.user.id);
    if (!utilisateur) return res.status(404).json({ message: 'Utilisateur introuvable' });

    const { nom, prenom, email, currentPassword, newPassword } = req.body;

    await updateOwnPasswordIfRequested(utilisateur, { currentPassword, newPassword, email });
    await applyOwnProfileFields(utilisateur, { nom, prenom, email });

    await utilisateur.save();

    await auditUser.updated(utilisateur, req.user, req);

    res.json({
      id: utilisateur.id,
      nom: utilisateur.nom,
      prenom: utilisateur.prenom,
      email: utilisateur.email,
      role: utilisateur.role,
      message: 'Profil mis à jour avec succès'
    });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ message: err.message });
    }

    logger.error('Erreur mise à jour profil:', err);
    res.status(500).json({ message: 'Erreur serveur', error: err.message });
  }
}

module.exports = {
  createUser,
  getAllUsers,
  getUserById,
  updateUser,
  deleteUser,
  changeUserRole,
  updateOwnProfile
};