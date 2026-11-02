const { Entreprise, Utilisateur } = require('../models');
const { getLeaveRules } = require('./politiqueConges');
const { resolveManagerDelivery, getNamedRoute } = require('./managerCrossServicePolicy');
const notificationService = require('./notificationService');
const emailService = require('./emailService');
const logger = require('../utils/logger');
const { prepareRecipientSafely: prepareRecipient } = require('./businessNotificationContext');

async function notifyInformationRecipient({ recipient, entrepriseId, type, message, url, delivery, transaction }) {
  await notificationService.creerNotification({
    entreprise_id: entrepriseId, utilisateur_id: recipient.id, type, message, url,
    delivery, notification_mode: 'information', transaction,
  });
  if (delivery.email && recipient.email) {
    const send = () => emailService.sendEmail(recipient.email, message, 'manager-event-information', {
      entreprise_id: entrepriseId,
      notification_resource: url,
      destinataire_prenom: recipient.prenom || (recipient.role === 'admin_entreprise' ? 'Administrateur' : 'Manager'),
      notification_mode: 'information',
      message_principal: message,
    }).catch(error => logger.error('Erreur email de suivi', { error: error.message, recipientId: recipient.id, type }));
    if (transaction?.afterCommit) transaction.afterCommit(send);
    else await send();
  }
}

async function notifyAdminsInformationEvent({ entrepriseId, type, message, url, excludeUserIds = [], transaction = null }) {
  const admins = await Utilisateur.findAll({
    where: { entreprise_id: entrepriseId, role: 'admin_entreprise', statut: 'actif' },
    transaction,
  });
  for (const recipient of admins) {
    if (excludeUserIds.includes(recipient.id)) continue;
    await notifyInformationRecipient({
      recipient, entrepriseId, type, message, url, transaction,
      delivery: { canView: true, canAct: false, email: true, in_app: true, mode: 'information' },
    });
  }
}

async function notifyConfiguredManagerEvent({ entrepriseId, service, category, type, message, url, excludeUserIds = [], transaction = null, legacyEligible = true }) {
  const [entreprise, managers] = await Promise.all([
    Entreprise.findByPk(entrepriseId, { attributes: ['politique_conges'], transaction }),
    Utilisateur.findAll({
      where: { entreprise_id: entrepriseId, role: 'manager', statut: 'actif' },
      transaction,
    }),
  ]);
  const rules = getLeaveRules(entreprise);
  for (const manager of managers) {
    if (excludeUserIds.includes(manager.id)) continue;
    const local = manager.service && manager.service === service;
    const named = getNamedRoute(rules, service, category, manager.id)?.mode;
    const explicitCrossService = named || rules.service_policies?.[manager.service]?.manager_cross_service?.[category];
    const delivery = local && !named
      ? { canView: true, canAct: false, email: false, in_app: false, mode: 'information' }
      : resolveManagerDelivery({ rules, manager, targetService: service, category });
    if (local && !named || !explicitCrossService || !legacyEligible) {
      const prepared = await prepareRecipient({
        recipientId: manager.id, type, mode: 'information', legacy: false, channel: 'email', transaction,
      });
      const appPrepared = await prepareRecipient({
        recipientId: manager.id, type, mode: 'information', legacy: false, channel: 'in_app', transaction,
      });
      if (!local && !explicitCrossService) continue;
      delivery.email = prepared?.enabled === true;
      delivery.in_app = appPrepared?.enabled === true;
    }
    if (!delivery.email && !delivery.in_app) continue;
    await notifyInformationRecipient({
      recipient: manager, entrepriseId, type, message, url, delivery, transaction,
    });
  }
}

async function notifyConfiguredOwnerEvent(event) {
  const recipient = await Utilisateur.findByPk(event.ownerId, { transaction: event.transaction });
  if (!recipient) return;
  const email = await prepareRecipient({
    recipientId: recipient.id, type: event.type, mode: 'information', legacy: false,
    channel: 'email', transaction: event.transaction,
  });
  const inApp = await prepareRecipient({
    recipientId: recipient.id, type: event.type, mode: 'information', legacy: false,
    channel: 'in_app', transaction: event.transaction,
  });
  if (!email?.enabled && !inApp?.enabled) return;
  await notifyInformationRecipient({
    ...event, recipient,
    delivery: { canView: true, canAct: false, email: email?.enabled === true, in_app: inApp?.enabled === true, mode: 'information' },
  });
}

module.exports = { notifyConfiguredManagerEvent, notifyAdminsInformationEvent, notifyConfiguredOwnerEvent };
