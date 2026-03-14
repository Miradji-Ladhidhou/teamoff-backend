const { Notification } = require('../models');

/**
 * Crée une notification pour un utilisateur
 */
async function creerNotification({ entreprise_id, utilisateur_id, type, message, url }) {
  return Notification.create({ entreprise_id, utilisateur_id, type, message, url });
}

/**
 * Marque une notification comme lue
 */
async function marquerCommeLue(notificationId) {
  const notif = await Notification.findByPk(notificationId);
  if (!notif) throw new Error('Notification introuvable');

  notif.lu = true;
  await notif.save();
  return notif;
}

/**
 * Récupère toutes les notifications pour un utilisateur
 */
async function getNotificationsUtilisateur(utilisateurId, options = {}) {
  return Notification.findAll({
    where: { utilisateur_id: utilisateurId },
    order: [['created_at', 'DESC']],
    ...options
  });
}

module.exports = {
  creerNotification,
  marquerCommeLue,
  getNotificationsUtilisateur
};