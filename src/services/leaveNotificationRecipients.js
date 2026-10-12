const { Op } = require('sequelize');
const { Utilisateur, Entreprise, Notification } = require('../models');
const { getLeaveRules, getManagerServicePermissions } = require('./politiqueConges');
const { resolveManagerDelivery } = require('./managerCrossServicePolicy');
const { notifyAdminsInformationEvent } = require('./managerEventNotificationService');

async function getLeaveNotificationRecipients({ entrepriseId, service, workflow, stage = 'manager', reservation = false, transaction = null, informationOnly = false, requesterId = null }) {
  const managersNeeded = workflow === 'manager'
    || workflow === 'manager_only'
    || (workflow === 'manager_admin' && stage === 'manager')
    || (reservation && workflow === 'manager_admin');
  const adminsNeeded = workflow === 'admin_only'
    || (workflow === 'manager_admin' && stage === 'admin')
    || (reservation && workflow === 'manager_admin')
    || (reservation && workflow === 'auto');

  const managerStageRequired = workflow === 'manager'
    || workflow === 'manager_only'
    || (workflow === 'manager_admin' && stage === 'manager')
    || (reservation && workflow === 'manager_admin');
  let scopedManagers = [];
  {
    const [entreprise, managers] = await Promise.all([
      Entreprise.findByPk(entrepriseId, { attributes: ['politique_conges'], transaction }),
      Utilisateur.findAll({
        where: { entreprise_id: entrepriseId, role: 'manager', statut: 'actif' },
        attributes: ['id', 'entreprise_id', 'role', 'service', 'prenom', 'nom', 'email'],
        transaction,
      }),
    ]);
    const leaveRules = getLeaveRules(entreprise);
    const managerRecipients = managers.filter((manager) => {
      const delivery = resolveManagerDelivery({
        rules: leaveRules, manager, targetService: service,
        actionRequired: managerStageRequired && !informationOnly && manager.id !== requesterId,
        localEligible: managersNeeded || getManagerServicePermissions(leaveRules, manager).canViewAllServices,
      });
      const policy = leaveRules.service_policies?.[manager.service];
      const explicit = policy?.manager_cross_service?.conges !== undefined;
      if (!explicit && !managersNeeded && !adminsNeeded) return false;
      // Preserve legacy recipients while allowing independently selected channels.
      if (!explicit) {
        const permissions = getManagerServicePermissions(leaveRules, manager);
        const canReceive = (managerStageRequired && delivery.canAct) || permissions.canViewAllServices;
        delivery.email = canReceive;
        delivery.in_app = canReceive;
      }
      if (!delivery.email && !delivery.in_app) return false;
      manager.notification_mode = delivery.mode;
      manager.notification_delivery = delivery;
      manager.has_explicit_cross_service_policy = explicit;
      if (!delivery.email) manager.email = null;
      return true;
    });
    scopedManagers = managerRecipients;

    const hasManagerValidator = managersNeeded && managers.some(manager =>
      manager.id !== requesterId && resolveManagerDelivery({ rules: leaveRules, manager, targetService: service }).canAct);
    if (managerStageRequired && !hasManagerValidator) {
      await notifyAdminsNoServiceManager({ entrepriseId, service, transaction });
    }
  }

  const admins = await Utilisateur.findAll({
    where: { entreprise_id: entrepriseId, role: 'admin_entreprise', statut: 'actif' },
    transaction,
  });

  for (const admin of admins) {
    admin.notification_mode = workflow === 'admin_only'
      || (workflow === 'manager_admin' && stage === 'admin')
      ? 'action'
      : 'information';
    if (informationOnly) admin.notification_mode = 'information';
    admin.notification_delivery = {
      canView: true, canAct: admin.notification_mode === 'action',
      email: true, in_app: true, mode: admin.notification_mode,
    };
  }

  return [...new Map([...scopedManagers, ...admins].map((recipient) => [recipient.id, recipient])).values()];
}

async function notifyAdminsNoServiceManager({ entrepriseId, service, reference = null, transaction = null }) {
  const admins = await Utilisateur.findAll({
    where: { entreprise_id: entrepriseId, role: 'admin_entreprise', statut: 'actif' },
    attributes: ['id'],
    transaction,
  });
  if (!admins.length) return;

  const missingService = String(service || '').trim() || 'non défini';
  const referenceLabel = reference ? ` (${reference})` : '';
  const message = `Aucun manager actif n'est affecté au service ${missingService}${referenceLabel}. Assignez un manager pour traiter les demandes de ce service.`;
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const alreadyNotified = [];

  for (const admin of admins) {
    const existing = await Notification.findOne({
      where: {
        utilisateur_id: admin.id,
        type: 'manager_service_unassigned',
        message: { [Op.in]: [message, `Pour information — ${message}`] },
        created_at: { [Op.gte]: since },
      },
      transaction,
    });
    if (existing) alreadyNotified.push(admin.id);
  }
  await notifyAdminsInformationEvent({
    entrepriseId, type: 'manager_service_unassigned', message, url: '/users',
    excludeUserIds: alreadyNotified, transaction,
  });
}

module.exports = { getLeaveNotificationRecipients, notifyAdminsNoServiceManager };
