const { Notification, Utilisateur } = require('../models');
const nodemailer = require('nodemailer');
const fs = require('fs').promises;
const path = require('path');

const APP_NAME = process.env.EMAIL_NAME || 'TeamOff';
const APP_FROM = process.env.EMAIL_FROM || process.env.MAIL_USER;
const APP_FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
const DEFAULT_SIGNATURE = process.env.EMAIL_SIGNATURE || `L'equipe ${APP_NAME}`;

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

function htmlToText(html = '') {
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeSubject(subject = '') {
  const raw = String(subject || '').trim();
  if (!raw) return `${APP_NAME} - Notification`;
  if (raw.toLowerCase().includes(APP_NAME.toLowerCase())) return raw;
  return `${APP_NAME} - ${raw}`;
}

function replaceTemplateVariables(template, data = {}) {
  let rendered = String(template || '');
  const variables = {
    app_name: APP_NAME,
    frontend_url: APP_FRONTEND_URL,
    signature: DEFAULT_SIGNATURE,
    year: new Date().getFullYear(),
    ...data,
  };

  Object.keys(variables).forEach((key) => {
    rendered = rendered.replace(new RegExp(`{{${key}}}`, 'g'), String(variables[key] ?? ''));
  });

  return rendered;
}

async function renderEmailTemplate(templateName, data = {}) {
  const templatePath = path.join(__dirname, '../templates/emails', `${templateName}.html`);
  const template = await fs.readFile(templatePath, 'utf8');
  return replaceTemplateVariables(template, data);
}

function wrapProfessionalEmail({ subject, html }) {
  const safeSubject = String(subject || `${APP_NAME} - Notification`);
  const content = String(html || '').trim() || '<p>Une mise a jour est disponible.</p>';

  return `
    <!doctype html>
    <html lang="fr">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${safeSubject}</title>
      </head>
      <body style="margin:0;padding:0;background:#f5f7fb;font-family:Segoe UI,Arial,sans-serif;color:#1f2937;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f5f7fb;padding:24px 12px;">
          <tr>
            <td align="center">
              <table role="presentation" width="640" cellspacing="0" cellpadding="0" style="max-width:640px;width:100%;border-collapse:collapse;">
                <tr>
                  <td style="background:#0f172a;color:#ffffff;padding:18px 24px;border-radius:10px 10px 0 0;">
                    <div style="font-size:18px;font-weight:700;letter-spacing:0.2px;">${APP_NAME}</div>
                    <div style="font-size:13px;opacity:0.9;margin-top:4px;">Notification automatique</div>
                  </td>
                </tr>
                <tr>
                  <td style="background:#ffffff;border:1px solid #e5e7eb;border-top:none;padding:24px;line-height:1.55;">
                    ${content}
                    <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0 16px;" />
                    <p style="margin:0 0 4px;font-size:14px;">Cordialement,</p>
                    <p style="margin:0;font-size:14px;font-weight:600;">${DEFAULT_SIGNATURE}</p>
                  </td>
                </tr>
                <tr>
                  <td style="padding:14px 8px 0;text-align:center;color:#6b7280;font-size:12px;">
                    <div>${APP_NAME} - ${new Date().getFullYear()}</div>
                    <div style="margin-top:4px;">Cet email est envoye automatiquement, merci de ne pas y repondre.</div>
                    <div style="margin-top:8px;"><a href="${APP_FRONTEND_URL}" style="color:#2563eb;text-decoration:none;">Acceder a la plateforme</a></div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </body>
    </html>
  `;
}

/**
 * Envoi d'email
 */
async function sendEmail({ to, subject, html, templateName, data }) {
  if (!to) {
    throw new Error('No recipients defined');
  }

  const normalizedSubject = normalizeSubject(subject);
  let professionalHtml;

  if (templateName) {
    professionalHtml = await renderEmailTemplate(templateName, data || {});
  } else {
    professionalHtml = wrapProfessionalEmail({ subject: normalizedSubject, html });
  }

  const text = htmlToText(professionalHtml);

  return transporter.sendMail({
    from: `"${APP_NAME}" <${APP_FROM}>`,
    to,
    subject: normalizedSubject,
    html: professionalHtml,
    text,
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