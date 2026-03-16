const { Notification, Utilisateur } = require('../models');
const nodemailer = require('nodemailer');

/**
 * Configuration SMTP
 */
const transporter = nodemailer.createTransport({
  host: process.env.MAIL_HOST,
  port: Number(process.env.MAIL_PORT),
  secure: process.env.MAIL_SECURE === 'true',
  auth: {
    user: process.env.MAIL_USER,
    pass: process.env.MAIL_PASS
  }
});

/**
 * Envoi d'email
 */
async function sendEmail({ to, subject, html }) {
  if (!to) {
    throw new Error('No recipients defined');
  }

  return transporter.sendMail({
    from: `"${process.env.EMAIL_NAME}" <${process.env.EMAIL_FROM}>`,
    to,
    subject,
    html
  });
}

/**
 * Création d'une notification DB
 */
async function creerNotification({
  entreprise_id,
  utilisateur_id,
  type,
  message,
  url = null
}) {
  return Notification.create({
    entreprise_id,
    utilisateur_id,
    type,
    message,
    url
  });
}

/**
 * Notification complète : DB + Email
 */
async function notifyUser({
  utilisateurId,
  type,
  message,
  url,
  emailSubject,
  emailHtml
}) {

  const utilisateur = await Utilisateur.findByPk(utilisateurId);

  if (!utilisateur) {
    throw new Error('Utilisateur introuvable');
  }

  // 1️⃣ Création notification DB
  const notification = await creerNotification({
    entreprise_id: utilisateur.entreprise_id,
    utilisateur_id: utilisateur.id,
    type,
    message,
    url
  });

  // 2️⃣ Envoi email (non bloquant)
  if (utilisateur.email) {
    try {
      await sendEmail({
        to: utilisateur.email,
        subject: emailSubject || type,
        html: emailHtml || `<p>${message}</p>`
      });
    } catch (error) {
      console.error('Erreur envoi email:', error.message);
    }
  }

  return notification;
}

/**
 * Notifications utilisateur
 */
async function getNotificationsUtilisateur(utilisateurId) {
  return Notification.findAll({
    where: { utilisateur_id: utilisateurId },
    order: [['created_at', 'DESC']]
  });
}

/**
 * Marquer notification comme lue
 */
async function marquerCommeLue(notificationId) {

  const notification = await Notification.findByPk(notificationId);

  if (!notification) {
    throw new Error('Notification introuvable');
  }

  notification.lu = true;
  await notification.save();

  return notification;
}

module.exports = {
  sendEmail,
  creerNotification,
  notifyUser,
  getNotificationsUtilisateur,
  marquerCommeLue
};