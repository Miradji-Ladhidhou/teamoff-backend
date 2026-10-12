const { Entreprise, Utilisateur } = require('../models');
const { getLeaveRules } = require('./politiqueConges');
const { resolveManagerDelivery } = require('./managerCrossServicePolicy');
const notificationService = require('./notificationService');
const emailService = require('./emailService');
const logger = require('../utils/logger');

async function notifyInformationRecipient({ recipient, entrepriseId, type, message, url, delivery, transaction }) {
  await notificationService.creerNotification({
    entreprise_id: entrepriseId, utilisateur_id: recipient.id, type, message, url,
    delivery, notification_mode: 'information', transaction,
  });
  if (delivery.email && recipient.email) {
    const send = () => emailService.sendEmail(recipient.email, message, 'manager-event-information', {
      entreprise_id: entrepriseId,
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

async function notifyConfiguredManagerEvent({ entrepriseId, service, category, type, message, url, excludeUserIds = [], transaction = null }) {
  const [entreprise, managers] = await Promise.all([
    Entreprise.findByPk(entrepriseId, { attributes: ['politique_conges'], transaction }),
    Utilisateur.findAll({
      where: { entreprise_id: entrepriseId, role: 'manager', statut: 'actif' },
      transaction,
    }),
  ]);
  const rules = getLeaveRules(entreprise);
  for (const manager of managers) {
    if (excludeUserIds.includes(manager.id) || (manager.service && manager.service === service)) continue;
    if (!rules.service_policies?.[manager.service]?.manager_cross_service?.[category]) continue;
    const delivery = resolveManagerDelivery({ rules, manager, targetService: service, category });
    if (!delivery.email && !delivery.in_app) continue;
    await notifyInformationRecipient({
      recipient: manager, entrepriseId, type, message, url, delivery, transaction,
    });
  }
}

module.exports = { notifyConfiguredManagerEvent, notifyAdminsInformationEvent };
