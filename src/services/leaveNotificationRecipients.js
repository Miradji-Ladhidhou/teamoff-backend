const { Op } = require('sequelize');
const { Utilisateur, Entreprise, Notification } = require('../models');
const { getLeaveRules, getManagerServicePermissions } = require('./politiqueConges');
const notificationService = require('./notificationService');

async function getLeaveNotificationRecipients({ entrepriseId, service, workflow, stage = 'manager', reservation = false, transaction = null }) {
  const managersNeeded = workflow === 'manager'
    || workflow === 'manager_only'
    || (workflow === 'manager_admin' && stage === 'manager')
    || (reservation && workflow === 'manager_admin');
  const adminsNeeded = workflow === 'admin_only'
    || (workflow === 'manager_admin' && stage === 'admin')
    || (reservation && workflow === 'manager_admin')
    || (reservation && workflow === 'auto');

  if (!managersNeeded && !adminsNeeded) return [];

  const managerStageRequired = workflow === 'manager'
    || workflow === 'manager_only'
    || (workflow === 'manager_admin' && stage === 'manager')
    || (reservation && workflow === 'manager_admin');
  let scopedManagers = [];
  if (managersNeeded || workflow === 'manager_admin' || workflow === 'admin_only' || workflow === 'auto') {
    const [entreprise, managers] = await Promise.all([
      Entreprise.findByPk(entrepriseId, { attributes: ['politique_conges'], transaction }),
      Utilisateur.findAll({
        where: { entreprise_id: entrepriseId, role: 'manager', statut: 'actif' },
        attributes: ['id', 'entreprise_id', 'role', 'service', 'prenom', 'nom', 'email'],
        transaction,
      }),
    ]);
    const leaveRules = getLeaveRules(entreprise);
    const localManagers = service ? managers.filter((manager) => manager.service === service) : [];
    const managerRecipients = managers.filter((manager) => {
      const permissions = getManagerServicePermissions(leaveRules, manager);
      const isLocal = Boolean(service && manager.service === service);
      const canAct = managerStageRequired && (isLocal || permissions.canValidateAllServices);
      const canReceiveInformation = permissions.canViewAllServices;
      if (!canAct && !canReceiveInformation) return false;
      manager.notification_mode = canAct ? 'action' : 'information';
      return true;
    });
    scopedManagers = managerRecipients;

    const hasManagerValidator = managersNeeded && managerRecipients.some((manager) => manager.notification_mode === 'action');
    if (managerStageRequired && !hasManagerValidator) {
      await notifyAdminsNoServiceManager({ entrepriseId, service, transaction });
    }
  }

  const admins = adminsNeeded ? await Utilisateur.findAll({
    where: { entreprise_id: entrepriseId, role: 'admin_entreprise', statut: 'actif' },
    transaction,
  }) : [];

  for (const admin of admins) {
    admin.notification_mode = workflow === 'admin_only'
      || (workflow === 'manager_admin' && stage === 'admin')
      ? 'action'
      : 'information';
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

  for (const admin of admins) {
    const existing = await Notification.findOne({
      where: {
        utilisateur_id: admin.id,
        type: 'manager_service_unassigned',
        message,
        created_at: { [Op.gte]: since },
      },
      transaction,
    });
    if (!existing) {
      await notificationService.creerNotification({
        entreprise_id: entrepriseId,
        utilisateur_id: admin.id,
        type: 'manager_service_unassigned',
        message,
        url: '/users',
        transaction,
      });
    }
  }
}

module.exports = { getLeaveNotificationRecipients, notifyAdminsNoServiceManager };
