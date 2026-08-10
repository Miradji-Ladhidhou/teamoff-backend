const bcrypt  = require('bcrypt');
const crypto  = require('crypto');
const jwt     = require('jsonwebtoken');
const { Entreprise, Utilisateur, LeavePolicy, sequelize } = require('../models');
const logger = require('../utils/logger');
const { validationResult } = require('express-validator');
const { auditEntreprise, auditUser } = require('../services/auditHelper');
const emailService = require('../services/emailService');
const quotasService = require('../services/quotasService');
const { BCRYPT_COST } = require('../services/authService');

// Compte racine insupprimable — l'entreprise qui le contient l'est également
const PROTECTED_SUPER_ADMIN_EMAIL = 'saas.teamoff@gmail.com';

const DEFAULT_SERVICE_POLICY = {
  overlap_behavior: 'block',
  minimum_notice_days: 0,
  max_consecutive_days: 365,
  approval_workflow: 'manager_admin',
  max_employees_on_leave: 0,
};

function normalizeServiceName(value) {
  return String(value || '').trim();
}

function normalizeServicePolicy(policy = {}) {
  const approvalWorkflow = ['manager_admin', 'manager_only', 'admin_only'].includes(policy.approval_workflow)
    ? policy.approval_workflow
    : DEFAULT_SERVICE_POLICY.approval_workflow;
  const overlapBehavior = ['block', 'warning'].includes(policy.overlap_behavior)
    ? policy.overlap_behavior
    : DEFAULT_SERVICE_POLICY.overlap_behavior;

  return {
    overlap_behavior: overlapBehavior,
    minimum_notice_days: Number(policy.minimum_notice_days || 0),
    max_consecutive_days: Number(policy.max_consecutive_days || DEFAULT_SERVICE_POLICY.max_consecutive_days),
    approval_workflow: approvalWorkflow,
    max_employees_on_leave: Number(policy.max_employees_on_leave || 0),
  };
}

function getEntreprisePolicies(entreprise) {
  const current = entreprise.politique_conges || {};
  return {
    ...current,
    service_policies: { ...(current.service_policies || {}) },
    max_employees_on_leave: {
      ...(current.max_employees_on_leave || {}),
      by_service: { ...((current.max_employees_on_leave || {}).by_service || {}) },
    },
  };
}

// ----------------------------
// Création d'une entreprise
// ----------------------------
// Si le body contient un champ `admin` (email, prenom, nom), l'entreprise ET
// l'utilisateur admin sont créés dans la même transaction DB (Fix #33).
// En cas d'échec de l'une ou l'autre création, tout est rollbacké — aucune
// entreprise orpheline ne peut subsister.
async function createEntreprise(req, res, next) {
  const { nom, politique_conges, parametres, statut, admin: adminData } = req.body;
  if (!nom) return res.status(400).json({ message: 'Nom requis' });

  if (adminData != null) {
    if (!adminData.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminData.email)) {
      return res.status(400).json({ message: 'admin.email est requis et doit être une adresse valide' });
    }
  }

  try {
    let entreprise, adminUser;

    await sequelize.transaction(async (t) => {
      entreprise = await Entreprise.create(
        { nom, politique_conges, parametres, statut },
        { transaction: t }
      );

      if (adminData?.email) {
        // Vérification unicité globale de l'email : un email ne doit appartenir qu'à
        // un seul compte, quelle que soit l'entreprise (évite l'ambiguïté de login).
        const existing = await Utilisateur.findOne({
          where: { email: adminData.email },
          attributes: ['id'],
          transaction: t,
        });
        if (existing) {
          const err = new Error('Un utilisateur avec cet email existe déjà');
          err.statusCode = 409;
          throw err;
        }

        const placeholderHash = await bcrypt.hash(
          crypto.randomBytes(32).toString('hex'), BCRYPT_COST
        );
        adminUser = await Utilisateur.create({
          nom:    adminData.nom    || '',
          prenom: adminData.prenom || '',
          email:  adminData.email,
          role:   'admin_entreprise',
          entreprise_id: entreprise.id,
          password_hash: placeholderHash,
          statut: 'en_attente',
        }, { transaction: t });

        await quotasService.initializeUserCounters({
          entrepriseId: entreprise.id,
          utilisateurId: adminUser.id,
          annee: new Date().getFullYear(),
          transaction: t,
        });
      }
    });

    // Post-transaction : token d'invitation + emails (fire-and-forget hors transaction)
    if (adminUser) {
      const inviteToken = jwt.sign(
        { id: adminUser.id, type: 'set_password' },
        process.env.JWT_SECRET,
        { expiresIn: '48h' }
      );
      const inviteHash = crypto.createHash('sha256').update(inviteToken).digest('hex');
      await adminUser.update({ invite_token_hash: inviteHash });

      emailService.sendSetPasswordEmail(adminUser, entreprise, inviteToken)
        .catch(err => logger.error('Erreur email invitation admin entreprise', { error: err.message }));

      await auditUser.created(adminUser, req.user, req);
    }

    await auditEntreprise.created(entreprise, req.user, req);

    const creator = await Utilisateur.findByPk(req.user.id, {
      attributes: ['id', 'prenom', 'nom', 'email']
    });
    if (creator?.email) {
      emailService.sendEntrepriseCreatedEmail(creator, entreprise)
        .catch(err => logger.error('Erreur envoi email création entreprise', { error: err.message }));
    }

    if (adminUser) {
      return res.status(201).json({
        entreprise,
        admin: {
          id:     adminUser.id,
          email:  adminUser.email,
          prenom: adminUser.prenom,
          nom:    adminUser.nom,
          role:   adminUser.role,
          statut: adminUser.statut,
        },
      });
    }

    res.status(201).json(entreprise);

  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ message: err.message });
    logger.error('Erreur création entreprise:', err);
    next(err);
  }
}

// ----------------------------
// Liste toutes les entreprises
// ----------------------------
async function getAllEntreprises(req, res, next) {
  try {
    const entreprises = await Entreprise.findAll({ order: [['nom', 'ASC']] });
    res.json(entreprises);
  } catch (err) {
    logger.error('Erreur récupération entreprises:', err);
    next(err);
  }
}

// ----------------------------
// Détail d'une entreprise
// ----------------------------
async function getEntrepriseById(req, res, next) {
  try {
    const entreprise = await Entreprise.findByPk(req.params.id);
    if (!entreprise) return res.status(404).json({ message: 'Entreprise introuvable' });
    res.json(entreprise);
  } catch (err) {
    logger.error('Erreur récupération entreprise:', err);
    next(err);
  }
}

// ----------------------------
// Mise à jour d'une entreprise
// ----------------------------
async function updateEntreprise(req, res, next) {
  try {
    const entreprise = await Entreprise.findByPk(req.params.id);
    if (!entreprise) return res.status(404).json({ message: 'Entreprise introuvable' });

    const oldData = { nom: entreprise.nom };

    // Préserver les service_policies lors de la mise à jour (stockés dans politique_conges)
    const updateData = { ...req.body };
    if (updateData.politique_conges && entreprise.politique_conges) {
      const existing = entreprise.politique_conges;
      updateData.politique_conges = {
        ...updateData.politique_conges,
        service_policies: updateData.politique_conges.service_policies ?? existing.service_policies,
        max_employees_on_leave: {
          ...(updateData.politique_conges.max_employees_on_leave || {}),
          by_service: updateData.politique_conges.max_employees_on_leave?.by_service
            ?? existing.max_employees_on_leave?.by_service,
        },
      };
    }

    await entreprise.update(updateData, { userId: req.user.id });

    // === Audit ===
    await auditEntreprise.updated(entreprise, req.user, req, { oldData, updates: req.body });

    res.json(entreprise);
  } catch (err) {
    logger.error('Erreur mise à jour entreprise:', err);
    next(err);
  }
}

// ----------------------------
// Suppression d'une entreprise
// ----------------------------
async function deleteEntreprise(req, res, next) {
  try {
    const entreprise = await Entreprise.findByPk(req.params.id);
    if (!entreprise) return res.status(404).json({ message: 'Entreprise introuvable' });

    const hasProtectedAdmin = await Utilisateur.count({
      where: { entreprise_id: entreprise.id, email: PROTECTED_SUPER_ADMIN_EMAIL },
    });
    if (hasProtectedAdmin) {
      return res.status(403).json({ message: 'Cette entreprise est protégée et ne peut pas être supprimée' });
    }

    // Log écrit AVANT destroy : avec SET NULL, le destroy nullifie entreprise_id
    // mais entity_id + action + metadata restent intacts pour traçabilité post-mortem.
    await auditEntreprise.deleted(entreprise, req.user, req);

    await entreprise.destroy({ userId: req.user.id });

    res.json({ message: 'Entreprise supprimée' });
  } catch (err) {
    logger.error('Erreur suppression entreprise:', err);
    next(err);
  }
}

// ----------------------------
// Changement de statut entreprise
// ----------------------------
async function patchStatutEntreprise(req, res, next) {
  const { statut } = req.body;
  const allowed = ['active', 'inactive', 'suspendue'];
  if (!allowed.includes(statut)) return res.status(400).json({ message: 'Statut invalide' });

  try {
    const entreprise = await Entreprise.findByPk(req.params.id);
    if (!entreprise) return res.status(404).json({ message: 'Entreprise introuvable' });

    const oldStatut = entreprise.statut;
    await entreprise.update({ statut }, { userId: req.user.id });

    // Email de suspension aux admins de l'entreprise
    if (statut === 'suspendue' && oldStatut !== 'suspendue') {
      const admins = await Utilisateur.findAll({
        where: { entreprise_id: entreprise.id, role: 'admin_entreprise', statut: 'actif' },
        attributes: ['email', 'prenom', 'nom'],
      });
      for (const admin of admins) {
        emailService.sendEnterpriseSuspended(admin, entreprise).catch((e) =>
          logger.error('sendEnterpriseSuspended error', { error: e.message })
        );
      }
    }

    // === Audit ===
    await auditEntreprise.updated(entreprise, req.user, req, { oldStatut, newStatut: statut });

    res.json({ message: 'Statut entreprise mis à jour', entreprise });
  } catch (err) {
    logger.error('Erreur mise à jour statut:', err);
    next(err);
  }
}

// ----------------------------
// Jours bloqués — accessible à tous les rôles de l'entreprise
// ----------------------------
async function getBlockedDays(req, res, next) {
  try {
    const entreprise = await Entreprise.findByPk(req.params.id, {
      attributes: ['id', 'politique_conges'],
    });
    if (!entreprise) return res.status(404).json({ message: 'Entreprise introuvable' });

    // Isolation multi-tenant : un non-super_admin ne peut lire que sa propre entreprise
    if (req.user.role !== 'super_admin' && req.user.entreprise_id !== req.params.id) {
      return res.status(403).json({ message: 'Accès interdit' });
    }

    const pol = entreprise.politique_conges || {};
    const lp = await LeavePolicy.findOne({ where: { entreprise_id: req.params.id } });
    res.json({
      blocked_days: pol.blocked_days || {},
      allow_employee_cancel_own_pending: pol.allow_employee_cancel_own_pending !== undefined
        ? Boolean(pol.allow_employee_cancel_own_pending) : true,
      allow_manager_cancel_own_pending: pol.allow_manager_cancel_own_pending !== undefined
        ? Boolean(pol.allow_manager_cancel_own_pending) : true,
      allow_modify_validated: lp ? Boolean(lp.allow_modify_validated) : false,
      allow_cancel_validated: lp ? Boolean(lp.allow_cancel_validated) : false,
      min_notice_days: lp ? Number(lp.min_notice_days || 0) : 0,
    });
  } catch (err) {
    logger.error('Erreur récupération blocked_days:', err);
    next(err);
  }
}

// Politique de congés
// ----------------------------
async function getPolitiqueConges(req, res, next) {
  try {
    const entreprise = await Entreprise.findByPk(req.params.id);
    if (!entreprise) return res.status(404).json({ message: 'Entreprise introuvable' });

    res.json({ politique_conges: entreprise.politique_conges });
  } catch (err) {
    logger.error('Erreur récupération politique:', err);
    next(err);
  }
}

async function updatePolitiqueConges(req, res, next) {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const entreprise = await Entreprise.findByPk(req.params.id);
    if (!entreprise) return res.status(404).json({ message: 'Entreprise introuvable' });

    const oldPolitique = { ...entreprise.politique_conges };
    entreprise.politique_conges = { ...entreprise.politique_conges, ...req.body.politique_conges };
    await entreprise.save({ userId: req.user.id });

    // === Audit ===
    await auditEntreprise.updated(entreprise, req.user, req, { oldPolitique, newPolitique: entreprise.politique_conges });

    res.json({ message: 'Politique de congés mise à jour', politique_conges: entreprise.politique_conges });
  } catch (err) {
    logger.error('Erreur mise à jour politique:', err);
    next(err);
  }
}

// ----------------------------
// Paramètres généraux
// ----------------------------
function isValidTimezone(tz) {
  if (!tz || typeof tz !== 'string') return false;
  try { Intl.DateTimeFormat(undefined, { timeZone: tz }); return true; } catch { return false; }
}

async function getParametres(req, res, next) {
  try {
    const entreprise = await Entreprise.findByPk(req.params.id);
    if (!entreprise) return res.status(404).json({ message: 'Entreprise introuvable' });
    res.json({ parametres: entreprise.parametres || {} });
  } catch (err) {
    logger.error('Erreur récupération paramètres:', err);
    next(err);
  }
}

async function updateParametres(req, res, next) {
  try {
    const entreprise = await Entreprise.findByPk(req.params.id);
    if (!entreprise) return res.status(404).json({ message: 'Entreprise introuvable' });

    const { parametres } = req.body;
    if (!parametres || typeof parametres !== 'object' || Array.isArray(parametres)) {
      return res.status(400).json({ message: 'Paramètres invalides' });
    }

    if (parametres.timezone !== undefined && !isValidTimezone(parametres.timezone)) {
      return res.status(400).json({ message: 'Fuseau horaire invalide' });
    }

    // Seules les clés autorisées sont acceptées
    const safeParametres = {};
    if (parametres.timezone !== undefined) safeParametres.timezone = parametres.timezone;

    const oldParametres = { ...(entreprise.parametres || {}) };
    entreprise.parametres = { ...oldParametres, ...safeParametres };
    await entreprise.save({ userId: req.user.id });

    res.json({ message: 'Paramètres mis à jour', parametres: entreprise.parametres });
  } catch (err) {
    logger.error('Erreur mise à jour paramètres:', err);
    next(err);
  }
}

async function getEntrepriseServices(req, res, next) {
  try {
    const entreprise = await Entreprise.findByPk(req.params.id);
    if (!entreprise) return res.status(404).json({ message: 'Entreprise introuvable' });

    const policy = getEntreprisePolicies(entreprise);
    const users = await Utilisateur.findAll({
      where: { entreprise_id: entreprise.id },
      attributes: ['service'],
    });

    // Services doivent exister dans service_policies (source autoritaire)
    const policyServiceNames = Object.keys(policy.service_policies || {}).sort((a, b) =>
      a.localeCompare(b, 'fr')
    );

    const employeesByService = users.reduce((acc, u) => {
      const service = normalizeServiceName(u.service);
      if (!service) return acc;
      acc[service] = (acc[service] || 0) + 1;
      return acc;
    }, {});

    const services = policyServiceNames.map((name) => ({
      name,
      employeesCount: employeesByService[name] || 0,
      policy: normalizeServicePolicy({
        ...(policy.service_policies[name] || {}),
        max_employees_on_leave: Number(policy.max_employees_on_leave?.by_service?.[name] || policy.service_policies?.[name]?.max_employees_on_leave || 0),
      }),
    }));

    res.json({ items: services });
  } catch (err) {
    logger.error('Erreur récupération services entreprise:', err);
    next(err);
  }
}

async function createEntrepriseService(req, res, next) {
  try {
    const entreprise = await Entreprise.findByPk(req.params.id);
    if (!entreprise) return res.status(404).json({ message: 'Entreprise introuvable' });

    const name = normalizeServiceName(req.body?.name);
    if (!name) return res.status(400).json({ message: 'Le nom du service est obligatoire' });

    const policy = getEntreprisePolicies(entreprise);
    const existingName = Object.keys(policy.service_policies || {}).find(
      (item) => item.toLowerCase() === name.toLowerCase()
    );
    if (existingName) {
      return res.status(409).json({ message: 'Ce service existe déjà' });
    }

    const nextServicePolicy = normalizeServicePolicy(req.body?.policy || {});
    policy.service_policies[name] = nextServicePolicy;
    policy.max_employees_on_leave.by_service[name] = Number(nextServicePolicy.max_employees_on_leave || 0);

    const oldPolitique = { ...(entreprise.politique_conges || {}) };
    entreprise.politique_conges = policy;
    await entreprise.save({ userId: req.user.id });

    await auditEntreprise.updated(entreprise, req.user, req, {
      oldPolitique,
      newPolitique: entreprise.politique_conges,
      service_action: 'created',
      service_name: name,
    });

    res.status(201).json({ message: 'Service créé', item: { name, policy: nextServicePolicy, employeesCount: 0 } });
  } catch (err) {
    logger.error('Erreur création service entreprise:', err);
    next(err);
  }
}

async function updateEntrepriseService(req, res, next) {
  try {
    const entreprise = await Entreprise.findByPk(req.params.id);
    if (!entreprise) return res.status(404).json({ message: 'Entreprise introuvable' });

    const currentName = normalizeServiceName(decodeURIComponent(req.params.serviceName || ''));
    if (!currentName) return res.status(400).json({ message: 'Service invalide' });

    const nextName = normalizeServiceName(req.body?.name || currentName);
    if (!nextName) return res.status(400).json({ message: 'Le nom du service est obligatoire' });

    const policy = getEntreprisePolicies(entreprise);
    if (!policy.service_policies[currentName]) {
      return res.status(404).json({ message: 'Service introuvable' });
    }

    const conflicting = Object.keys(policy.service_policies || {}).find(
      (item) => item !== currentName && item.toLowerCase() === nextName.toLowerCase()
    );
    if (conflicting) {
      return res.status(409).json({ message: 'Un autre service porte déjà ce nom' });
    }

    const previousServicePolicy = policy.service_policies[currentName] || {};
    const mergedServicePolicy = normalizeServicePolicy({
      ...previousServicePolicy,
      ...(req.body?.policy || {}),
    });

    delete policy.service_policies[currentName];
    policy.service_policies[nextName] = mergedServicePolicy;

    const currentLimit = Number(policy.max_employees_on_leave.by_service[currentName] || previousServicePolicy.max_employees_on_leave || 0);
    delete policy.max_employees_on_leave.by_service[currentName];
    policy.max_employees_on_leave.by_service[nextName] = Number(
      req.body?.policy?.max_employees_on_leave ?? mergedServicePolicy.max_employees_on_leave ?? currentLimit
    );

    if (currentName !== nextName) {
      await Utilisateur.update(
        { service: nextName },
        { where: { entreprise_id: entreprise.id, service: currentName } }
      );
    }

    const oldPolitique = { ...(entreprise.politique_conges || {}) };
    entreprise.politique_conges = policy;
    await entreprise.save({ userId: req.user.id });

    await auditEntreprise.updated(entreprise, req.user, req, {
      oldPolitique,
      newPolitique: entreprise.politique_conges,
      service_action: 'updated',
      from: currentName,
      to: nextName,
    });

    const employeesCount = await Utilisateur.count({ where: { entreprise_id: entreprise.id, service: nextName } });
    res.json({
      message: 'Service mis à jour',
      item: {
        name: nextName,
        employeesCount,
        policy: normalizeServicePolicy({
          ...policy.service_policies[nextName],
          max_employees_on_leave: Number(policy.max_employees_on_leave.by_service[nextName] || 0),
        }),
      },
    });
  } catch (err) {
    logger.error('Erreur mise à jour service entreprise:', err);
    next(err);
  }
}

async function deleteEntrepriseService(req, res, next) {
  try {
    const entreprise = await Entreprise.findByPk(req.params.id);
    if (!entreprise) return res.status(404).json({ message: 'Entreprise introuvable' });

    const serviceName = normalizeServiceName(decodeURIComponent(req.params.serviceName || ''));
    if (!serviceName) return res.status(400).json({ message: 'Service invalide' });

    const policy = getEntreprisePolicies(entreprise);
    if (!policy.service_policies[serviceName]) {
      return res.status(404).json({ message: 'Service introuvable' });
    }

    const assignedUsers = await Utilisateur.count({
      where: { entreprise_id: entreprise.id, service: serviceName },
    });
    if (assignedUsers > 0) {
      return res.status(400).json({
        message: `Ce service est encore affecté à ${assignedUsers} utilisateur(s). Réaffectez-les avant suppression.`,
      });
    }

    delete policy.service_policies[serviceName];
    delete policy.max_employees_on_leave.by_service[serviceName];

    const oldPolitique = { ...(entreprise.politique_conges || {}) };
    entreprise.politique_conges = policy;
    await entreprise.save({ userId: req.user.id });

    await auditEntreprise.updated(entreprise, req.user, req, {
      oldPolitique,
      newPolitique: entreprise.politique_conges,
      service_action: 'deleted',
      service_name: serviceName,
    });

    res.json({ message: 'Service supprimé' });
  } catch (err) {
    logger.error('Erreur suppression service entreprise:', err);
    next(err);
  }
}

module.exports = {
  createEntreprise,
  getAllEntreprises,
  getEntrepriseById,
  updateEntreprise,
  deleteEntreprise,
  patchStatutEntreprise,
  getBlockedDays,
  getPolitiqueConges,
  updatePolitiqueConges,
  getParametres,
  updateParametres,
  getEntrepriseServices,
  createEntrepriseService,
  updateEntrepriseService,
  deleteEntrepriseService,
};