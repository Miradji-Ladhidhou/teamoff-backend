const { Entreprise, Utilisateur } = require('../models');
const { validationResult } = require('express-validator');
const { auditEntreprise } = require('../services/auditHelper');
const emailService = require('../services/emailService');

const DEFAULT_SERVICE_POLICY = {
  overlap_policy: 'block',
  minimum_notice_days: 0,
  max_consecutive_days: 365,
  approval_workflow: 'manager_admin',
  max_employees_on_leave: 0,
};

function normalizeServiceName(value) {
  return String(value || '').trim();
}

function normalizeServicePolicy(policy = {}) {
  const overlapPolicy = ['block', 'warning', 'allow'].includes(policy.overlap_policy)
    ? policy.overlap_policy
    : DEFAULT_SERVICE_POLICY.overlap_policy;

  const approvalWorkflow = ['manager_admin', 'manager_only', 'admin_only'].includes(policy.approval_workflow)
    ? policy.approval_workflow
    : DEFAULT_SERVICE_POLICY.approval_workflow;

  return {
    overlap_policy: overlapPolicy,
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
async function createEntreprise(req, res) {

  const { nom, politique_conges, parametres, statut } = req.body;

  if (!nom) return res.status(400).json({ message: 'Nom requis' });

  try {

    const entreprise = await Entreprise.create(
      {
        nom,
        politique_conges,
        parametres,
        statut
      },
      { userId: req.user.id }
    );

    await auditEntreprise.created(entreprise, req.user, req);

    const creator = await Utilisateur.findByPk(req.user.id, {
      attributes: ['id', 'prenom', 'nom', 'email']
    });

    if (creator?.email) {
      await emailService.sendEntrepriseCreatedEmail(creator, entreprise);
    }

    res.status(201).json(entreprise);

  } catch (err) {
    console.error('Erreur création entreprise:', err);
    res.status(500).json({ message: 'Erreur serveur', error: err.message });
  }
}

// ----------------------------
// Liste toutes les entreprises
// ----------------------------
async function getAllEntreprises(req, res) {
  try {
    const entreprises = await Entreprise.findAll({ order: [['nom', 'ASC']] });
    res.json(entreprises);
  } catch (err) {
    console.error('Erreur récupération entreprises:', err);
    res.status(500).json({ message: 'Erreur serveur', error: err.message });
  }
}

// ----------------------------
// Détail d'une entreprise
// ----------------------------
async function getEntrepriseById(req, res) {
  try {
    const entreprise = await Entreprise.findByPk(req.params.id);
    if (!entreprise) return res.status(404).json({ message: 'Entreprise introuvable' });
    res.json(entreprise);
  } catch (err) {
    console.error('Erreur récupération entreprise:', err);
    res.status(500).json({ message: 'Erreur serveur', error: err.message });
  }
}

// ----------------------------
// Mise à jour d'une entreprise
// ----------------------------
async function updateEntreprise(req, res) {
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
    console.error('Erreur mise à jour entreprise:', err);
    res.status(500).json({ message: 'Erreur serveur', error: err.message });
  }
}

// ----------------------------
// Suppression d'une entreprise
// ----------------------------
async function deleteEntreprise(req, res) {
  try {
    const entreprise = await Entreprise.findByPk(req.params.id);
    if (!entreprise) return res.status(404).json({ message: 'Entreprise introuvable' });

    await entreprise.destroy({ userId: req.user.id });

    // === Audit ===
    await auditEntreprise.deleted(entreprise, req.user, req);

    res.json({ message: 'Entreprise supprimée' });
  } catch (err) {
    console.error('Erreur suppression entreprise:', err);
    res.status(500).json({ message: 'Erreur serveur', error: err.message });
  }
}

// ----------------------------
// Changement de statut entreprise
// ----------------------------
async function patchStatutEntreprise(req, res) {
  const { statut } = req.body;
  const allowed = ['active', 'inactive', 'suspendue'];
  if (!allowed.includes(statut)) return res.status(400).json({ message: 'Statut invalide' });

  try {
    const entreprise = await Entreprise.findByPk(req.params.id);
    if (!entreprise) return res.status(404).json({ message: 'Entreprise introuvable' });

    const oldStatut = entreprise.statut;
    await entreprise.update({ statut }, { userId: req.user.id });

    // === Audit ===
    await auditEntreprise.updated(entreprise, req.user, req, { oldStatut, newStatut: statut });

    res.json({ message: 'Statut entreprise mis à jour', entreprise });
  } catch (err) {
    console.error('Erreur mise à jour statut:', err);
    res.status(500).json({ message: 'Erreur serveur', error: err.message });
  }
}

// ----------------------------
// Politique de congés
// ----------------------------
async function getPolitiqueConges(req, res) {
  try {
    const entreprise = await Entreprise.findByPk(req.params.id);
    if (!entreprise) return res.status(404).json({ message: 'Entreprise introuvable' });

    res.json({ politique_conges: entreprise.politique_conges });
  } catch (err) {
    console.error('Erreur récupération politique:', err);
    res.status(500).json({ message: 'Erreur serveur' });
  }
}

async function updatePolitiqueConges(req, res) {
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
    console.error('Erreur mise à jour politique:', err);
    res.status(500).json({ message: 'Erreur serveur' });
  }
}

async function getEntrepriseServices(req, res) {
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
    console.error('Erreur récupération services entreprise:', err);
    res.status(500).json({ message: 'Erreur serveur' });
  }
}

async function createEntrepriseService(req, res) {
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
    console.error('Erreur création service entreprise:', err);
    res.status(500).json({ message: 'Erreur serveur' });
  }
}

async function updateEntrepriseService(req, res) {
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
    console.error('Erreur mise à jour service entreprise:', err);
    res.status(500).json({ message: 'Erreur serveur' });
  }
}

async function deleteEntrepriseService(req, res) {
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
    console.error('Erreur suppression service entreprise:', err);
    res.status(500).json({ message: 'Erreur serveur' });
  }
}

module.exports = {
  createEntreprise,
  getAllEntreprises,
  getEntrepriseById,
  updateEntreprise,
  deleteEntreprise,
  patchStatutEntreprise,
  getPolitiqueConges,
  updatePolitiqueConges,
  getEntrepriseServices,
  createEntrepriseService,
  updateEntrepriseService,
  deleteEntrepriseService,
};