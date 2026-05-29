const nodemailer = require('nodemailer');
const dns = require('dns').promises;
const fs = require('fs').promises;
const path = require('path');
const { Utilisateur, Entreprise } = require('../models');
const systemSettingsService = require('./systemSettingsService');
const logger = require('../utils/logger');

const isEmailDebug = process.env.EMAIL_DEBUG === 'true';

function getFrontendUrl() {
  return (process.env.FRONTEND_URL || 'http://localhost:3001').split(',')[0].trim();
}

function emailLog(...args) {
  if (isEmailDebug) {
    logger.debug(...args);
  }
}

class EmailService {
  constructor() {
    this.defaultSmtpConfig = {
      host: process.env.MAIL_HOST,
      port: Number(process.env.MAIL_PORT || 587),
      secure: process.env.MAIL_SECURE === 'true',
      user: process.env.MAIL_USER,
      pass: process.env.MAIL_PASS,
      from: process.env.EMAIL_FROM || process.env.MAIL_USER,
    };
  }

  async createTransporter(smtpConfig) {
    const hostname = smtpConfig.host;
    let host = hostname;
    try {
      const addresses = await dns.resolve4(hostname);
      if (addresses.length) host = addresses[0];
    } catch { /* garde le hostname si resolve échoue */ }

    return nodemailer.createTransport({
      host,
      port: Number(smtpConfig.port),
      secure: Boolean(smtpConfig.secure),
      tls: { servername: hostname },
      auth: {
        user: smtpConfig.user,
        pass: smtpConfig.pass,
      },
    });
  }

  async getSmtpConfig() {
    try {
      const settings = await systemSettingsService.getSettings();
      return {
        host: settings.smtpHost || this.defaultSmtpConfig.host,
        port: Number(settings.smtpPort || this.defaultSmtpConfig.port),
        secure: this.defaultSmtpConfig.secure,
        user: settings.smtpUser || this.defaultSmtpConfig.user,
        pass: settings.smtpPassword || this.defaultSmtpConfig.pass,
        from: settings.emailFrom || this.defaultSmtpConfig.from,
      };
    } catch (_) {
      return this.defaultSmtpConfig;
    }
  }

  async buildHtml(templateName, data) {
    let html;
    try {
      const templatePath = path.join(__dirname, '../templates/emails', `${templateName}.html`);
      html = await fs.readFile(templatePath, 'utf8');
    } catch {
      if (!data.content) {
        data.content = this.buildFallbackContent(templateName, '', data);
      }
      html = await this.getDefaultTemplate();
    }
    return this.replaceTemplateVariables(html, data);
  }

  // Méthode générique d'envoi d'email
  // attachments: tableau nodemailer [{ filename, content (Buffer), contentType }]
  async sendEmail(to, subject, templateName, data = {}, attachments = []) {
    try {
      if (!data.signature) data.signature = 'TeamOff SaaS';

      if (process.env.MAIL_SIMULATE === 'true') {
        emailLog('Email simule:', { to, subject, data });
        return { success: true, test: true };
      }

      const html = await this.buildHtml(templateName, data);
      const fromName = process.env.EMAIL_NAME || 'TeamOff';
      const fromAddr = process.env.EMAIL_FROM || process.env.MAIL_USER;

      // Gmail API HTTP (googleapis) — priorité 1, HTTPS port 443, jamais bloqué
      if (process.env.GMAIL_CLIENT_ID && process.env.GMAIL_CLIENT_SECRET && process.env.GMAIL_REFRESH_TOKEN) {
        const { google } = require('googleapis');
        const oauth2Client = new google.auth.OAuth2(
          process.env.GMAIL_CLIENT_ID,
          process.env.GMAIL_CLIENT_SECRET
        );
        oauth2Client.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });
        const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

        const hasAttachments = attachments && attachments.length > 0;
        const outerBoundary = `outer_${Date.now()}`;
        const innerBoundary = `inner_${Date.now()}`;

        const rawParts = [
          `From: "${fromName}" <${fromAddr}>`,
          `To: ${Array.isArray(to) ? to.join(', ') : to}`,
          `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`,
          'MIME-Version: 1.0',
          hasAttachments
            ? `Content-Type: multipart/mixed; boundary="${outerBoundary}"`
            : `Content-Type: multipart/alternative; boundary="${innerBoundary}"`,
          '',
        ];

        if (hasAttachments) {
          // Wrapper multipart/mixed contenant la partie alternative + les pièces jointes
          rawParts.push(
            `--${outerBoundary}`,
            `Content-Type: multipart/alternative; boundary="${innerBoundary}"`,
            '',
          );
        }

        rawParts.push(
          `--${innerBoundary}`,
          'Content-Type: text/plain; charset=UTF-8',
          '',
          this.htmlToText(html),
          '',
          `--${innerBoundary}`,
          'Content-Type: text/html; charset=UTF-8',
          '',
          html,
          '',
          `--${innerBoundary}--`,
        );

        if (hasAttachments) {
          for (const att of attachments) {
            const b64 = Buffer.isBuffer(att.content)
              ? att.content.toString('base64')
              : Buffer.from(att.content).toString('base64');
            rawParts.push(
              '',
              `--${outerBoundary}`,
              `Content-Type: ${att.contentType || 'application/octet-stream'}; name="${att.filename}"`,
              'Content-Transfer-Encoding: base64',
              `Content-Disposition: attachment; filename="${att.filename}"`,
              '',
              b64,
            );
          }
          rawParts.push(`--${outerBoundary}--`);
        }

        const raw = Buffer.from(rawParts.join('\r\n')).toString('base64url');
        const sent = await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
        emailLog(`Email Gmail API envoyé à ${to}: ${sent.data.id}`);
        return { success: true, messageId: sent.data.id };
      }

      // Resend (HTTP API) — priorité 2
      if (process.env.RESEND_API_KEY) {
        const { Resend } = require('resend');
        const resend = new Resend(process.env.RESEND_API_KEY);
        const { data: sent, error } = await resend.emails.send({
          from: `${fromName} <${fromAddr}>`,
          to: Array.isArray(to) ? to : [to],
          subject,
          html,
          text: this.htmlToText(html),
          ...(attachments.length > 0 && {
            attachments: attachments.map(a => ({ filename: a.filename, content: a.content })),
          }),
        });
        if (error) throw new Error(error.message || JSON.stringify(error));
        emailLog(`Email Resend envoyé à ${to}: ${sent?.id}`);
        return { success: true, messageId: sent?.id };
      }

      // SMTP — priorité 3 (dev local)
      const smtpConfig = await this.getSmtpConfig();
      if (!smtpConfig.host || !smtpConfig.user || !smtpConfig.pass) {
        throw new Error('Configuration email manquante (GMAIL_CLIENT_ID, RESEND_API_KEY ou SMTP requis).');
      }

      const mailOptions = {
        from: `"${fromName}" <${smtpConfig.from || smtpConfig.user}>`,
        to,
        subject,
        html,
        text: this.htmlToText(html),
        ...(attachments.length > 0 && { attachments }),
      };

      const transporter = await this.createTransporter(smtpConfig);
      const info = await transporter.sendMail(mailOptions);
      emailLog(`Email SMTP envoyé à ${to}: ${info.messageId}`);
      return { success: true, messageId: info.messageId };
    } catch (error) {
      logger.error('email_send_error', { error: error.message });
      throw error;
    }
  }

  replaceTemplateVariables(html, data) {
    Object.keys(data).forEach(key => {
      const regex = new RegExp(`{{${key}}}`, 'g');
      html = html.replace(regex, data[key] || '');
    });

    const globals = {
      year: new Date().getFullYear(),
      app_name: process.env.EMAIL_NAME || 'TeamOff',
      frontend_url: getFrontendUrl(),
    };

    Object.keys(globals).forEach(key => {
      html = html.replace(new RegExp(`{{${key}}}`, 'g'), globals[key]);
    });

    return html;
  }

  buildFallbackContent(templateName, subject, data) {
    const fallbackByTemplate = {
      'superadmin-notification': `
        <p>Bonjour,</p>
        <p>Une nouvelle entreprise vient de s'inscrire sur ${process.env.EMAIL_NAME || 'TeamOff'}.</p>
        <p><strong>Entreprise :</strong> ${data.entreprise_nom || 'Non renseignée'}</p>
        <p><strong>Administrateur :</strong> ${data.admin_nom || 'Non renseigné'}</p>
        <p><strong>Email administrateur :</strong> ${data.admin_email || 'Non renseigné'}</p>
        <p><strong>Date :</strong> ${data.created_at || 'Non renseignée'}</p>
        <p><a href="${data.validation_url || getFrontendUrl() || '#'}">Ouvrir la gestion des entreprises</a></p>
      `,
      'password-reset': `
        <p>Bonjour,</p>
        <p>Une demande de réinitialisation de mot de passe a été effectuée.</p>
        <p><a href="${data.reset_url || '#'}">Réinitialiser le mot de passe</a></p>
        <p>Ce lien expire dans ${data.expiry_hours || 1} heure(s).</p>
      `,
      'password-reset-confirmation': `
        <p>Bonjour,</p>
        <p>Votre mot de passe a été mis à jour avec succès.</p>
        <p><a href="${data.login_url || '#'}">Se connecter</a></p>
      `,
      'user-invitation': `
        <p>Bonjour,</p>
        <p>${data.inviter_nom || 'Un administrateur'} vous a invité à rejoindre ${process.env.EMAIL_NAME || 'TeamOff'}.</p>
        <p><strong>Email :</strong> ${data.email || 'Non renseigné'}</p>
        <p><strong>Mot de passe temporaire :</strong> ${data.password_temporaire || 'Non renseigné'}</p>
        <p><a href="${data.login_url || '#'}">Se connecter</a></p>
      `,
      'registration-confirmation': `
        <p>Bonjour ${data.admin_prenom || ''} ${data.admin_nom || ''},</p>
        <p>Votre entreprise <strong>${data.entreprise_nom || 'Non renseignée'}</strong> a bien été inscrite sur ${process.env.EMAIL_NAME || 'TeamOff'}.</p>
        <p>Vous pouvez vous connecter avec l'adresse <strong>${data.admin_email || 'Non renseignée'}</strong>.</p>
        <p><strong>Parcours conseillé :</strong></p>
        <ol>
          <li>Connectez-vous à votre espace administrateur.</li>
          <li>Créez vos services et leurs workflows de validation.</li>
          <li>Paramétrez la politique de congés, les jours bloqués et les jours fériés.</li>
          <li>Ajoutez vos managers et employés.</li>
          <li>Faites une première demande test pour valider le circuit complet.</li>
        </ol>
        <p><a href="${data.login_url || '#'}">Accéder à la plateforme</a></p>
      `,
      'new-leave-request': `
        <p>Bonjour,</p>
        <p>Une nouvelle demande de congé nécessite votre validation.</p>
        <p><strong>Employé :</strong> ${data.employe_nom || 'Non renseigné'}</p>
        <p><strong>Période :</strong> ${data.dates || 'Non renseignée'}</p>
        <p><strong>Type :</strong> ${data.type_conge || 'Non renseigné'}</p>
        <p><a href="${data.validation_url || '#'}">Consulter la demande</a></p>
      `,
      'leave-status-update': `
        <p>Bonjour ${data.prenom || ''},</p>
        <p>Le statut de votre demande de congé a été mis à jour.</p>
        <p><strong>Statut :</strong> ${data.statut || 'Non renseigné'}</p>
        <p><strong>Période :</strong> ${data.dates || 'Non renseignée'}</p>
        <p><strong>Commentaire :</strong> ${data.commentaire || 'Aucun commentaire'}</p>
        <p><a href="${data.dashboard_url || '#'}">Voir mes congés</a></p>
      `,
      'leave-cancellation': `
        <p>Bonjour ${data.prenom || ''},</p>
        <p>Votre congé a été annulé.</p>
        <p><strong>Période :</strong> ${data.dates || 'Non renseignée'}</p>
        <p><strong>Commentaire :</strong> ${data.commentaire || data.raison || 'Non renseignée'}</p>
        <p><a href="${data.dashboard_url || '#'}">Voir mon espace</a></p>
      `,
      'monthly-report': `
        <p>Bonjour,</p>
        <p>Voici votre rapport mensuel pour ${data.entreprise_nom || 'votre entreprise'}.</p>
        <p><strong>Période :</strong> ${data.mois || ''} ${data.annee || ''}</p>
        <p><strong>Total congés :</strong> ${data.total_conges || 0}</p>
        <p><strong>Total employés :</strong> ${data.total_employes || 0}</p>
      `,
      'system-alert': `
        <p>Bonjour,</p>
        <p>Une alerte système a été détectée.</p>
        <p><strong>Sévérité :</strong> ${data.severity || 'Non renseignée'}</p>
        <p><strong>Type :</strong> ${data.alert_type || 'Non renseigné'}</p>
        <p><strong>Message :</strong> ${data.message || 'Non renseigné'}</p>
        <p><a href="${data.dashboard_url || '#'}">Voir le tableau de bord</a></p>
      `,
    };

    return fallbackByTemplate[templateName] || `
      <p>Bonjour,</p>
      <p>${subject}</p>
      <p>Un nouvel événement nécessite votre attention.</p>
    `;
  }

  async getDefaultTemplate() {
    return `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <style>
            body { font-family: Arial; line-height: 1.6; color: #333; margin:0;padding:0; }
            .container { max-width:600px;margin:0 auto;padding:20px; }
            .header { background:#4f46e5;color:white;padding:30px;text-align:center;border-radius:10px 10px 0 0; }
            .content { background:#fff;padding:30px;border:1px solid #e0e0e0;border-top:none;border-radius:0 0 10px 10px; }
            .footer { text-align:center;padding:20px;color:#666;font-size:12px;margin-top:20px; }
            .button { background:#4f46e5;color:white;padding:12px 30px;text-decoration:none;border-radius:5px;display:inline-block;margin:20px 0; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header"><h1>{{app_name}}</h1></div>
            <div class="content">{{content}}</div>
            <div class="footer">© {{year}} {{app_name}}. Email automatique.</div>
          </div>
        </body>
      </html>
    `;
  }

  htmlToText(html) {
    return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  }

  // ---------------------------
  // Emails spécifiques TeamOff
  // ---------------------------

  async sendSetPasswordEmail(user, entreprise, inviteToken) {
    const entrepriseNom = entreprise?.nom || 'Votre entreprise';
    const setPasswordUrl = `${getFrontendUrl()}/set-password?token=${inviteToken}`;

    return this.sendEmail(
      user.email,
      `Invitation à rejoindre ${process.env.EMAIL_NAME || 'TeamOff'}`,
      'set-password-invitation',
      {
        prenom: user.prenom,
        nom: user.nom,
        entreprise_nom: entrepriseNom,
        set_password_url: setPasswordUrl,
        content: `
          <p>Bonjour ${user.prenom} ${user.nom},</p>
          <p>Votre compte ${process.env.EMAIL_NAME || 'TeamOff'} a été créé pour <strong>${entrepriseNom}</strong>.</p>
          <p>Cliquez sur le bouton ci-dessous pour définir votre mot de passe et activer votre compte :</p>
          <p><a href="${setPasswordUrl}" style="background:#2563eb;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;display:inline-block;">Définir mon mot de passe</a></p>
          <p style="color:#6b7280;font-size:14px;">Ce lien est valable 48h. Si vous n'êtes pas à l'origine de cette invitation, ignorez cet email.</p>
        `,
      }
    );
  }

  async sendWelcomeEmail(user, entreprise, temporaryPassword) {
    const entrepriseNom = entreprise?.nom || 'Votre entreprise';
    const loginUrl = `${getFrontendUrl()}/login`;

    return this.sendEmail(
      user.email,
      `Bienvenue sur ${process.env.EMAIL_NAME} !`,
      'welcome',
      {
        prenom: user.prenom,
        nom: user.nom,
        entreprise_nom: entrepriseNom,
        entreprise_suffix: entreprise?.nom ? ` pour ${entrepriseNom}` : '',
        email: user.email,
        password_temporaire: temporaryPassword,
        login_url: loginUrl,
        change_password_url: `${getFrontendUrl()}/reset-password`,
        content: `
          <p>Bonjour ${user.prenom} ${user.nom},</p>
          <p>Votre compte ${process.env.EMAIL_NAME || 'TeamOff'} a été créé${entreprise?.nom ? ` pour ${entrepriseNom}` : ''}.</p>
          <p><strong>Email :</strong> ${user.email}</p>
          <p><strong>Mot de passe temporaire :</strong> ${temporaryPassword}</p>
          <p><strong>Entreprise :</strong> ${entrepriseNom}</p>
          <p>Connectez-vous ici : <a href="${loginUrl}">${loginUrl}</a></p>
        `,
      }
    );
  }

  async sendEntrepriseCreatedEmail(user, entreprise) {
    const prenom = user?.prenom || '';
    const nom = user?.nom || '';
    const nomComplet = `${prenom} ${nom}`.trim() || 'Administrateur';

    return this.sendEmail(
      user.email,
      `Entreprise créée: ${entreprise.nom}`,
      'entreprise-created',
      {
        prenom,
        nom,
        nom_complet: nomComplet,
        entreprise_nom: entreprise.nom,
        entreprise_statut: entreprise.statut,
        created_at: new Date().toLocaleString('fr-FR'),
        dashboard_url: `${getFrontendUrl()}/superadmin/companies`,
        content: `
          <p>Bonjour ${nomComplet},</p>
          <p>L'entreprise <strong>${entreprise.nom}</strong> a été créée avec le statut <strong>${entreprise.statut}</strong>.</p>
          <p>Vous pouvez la gérer depuis votre espace super administrateur.</p>
        `,
      }
    );
  }

  async sendRegistrationConfirmation(entreprise, admin) {
    const frontendUrl = getFrontendUrl();
    const loginUrl = `${frontendUrl}/login`;
    const dashboardUrl = `${frontendUrl}/dashboard`;
    const servicesUrl = `${frontendUrl}/services`;
    const policyUrl = `${frontendUrl}/politique-conges`;
    const holidaysUrl = `${frontendUrl}/jours-feries`;
    const usersUrl = `${frontendUrl}/users`;

    return this.sendEmail(
      admin.email,
      `Confirmation d'inscription - ${entreprise.nom}`,
      'registration-confirmation',
      {
        admin_prenom: admin.prenom,
        admin_nom: admin.nom,
        admin_email: admin.email,
        entreprise_nom: entreprise.nom,
        login_url: loginUrl,
        dashboard_url: dashboardUrl,
        services_url: servicesUrl,
        policy_url: policyUrl,
        holidays_url: holidaysUrl,
        users_url: usersUrl,
        content: `
          <p>Bonjour ${admin.prenom} ${admin.nom},</p>
          <p>Votre entreprise <strong>${entreprise.nom}</strong> a bien été inscrite sur ${process.env.EMAIL_NAME || 'TeamOff'}.</p>
          <p>Votre compte administrateur est prêt avec l'adresse <strong>${admin.email}</strong>.</p>
          <p><strong>Tutoriel de démarrage recommandé :</strong></p>
          <ol>
            <li><strong>Connexion :</strong> accédez à votre espace via <a href="${loginUrl}">${loginUrl}</a>.</li>
            <li><strong>Services :</strong> créez vos équipes et définissez les workflows de validation dans <a href="${servicesUrl}">Services</a>.</li>
            <li><strong>Politique de congés :</strong> configurez les règles de calcul dans <a href="${policyUrl}">Politique congés</a>.</li>
            <li><strong>Jours fériés et jours bloqués :</strong> vérifiez votre calendrier RH dans <a href="${holidaysUrl}">Jours fériés</a>.</li>
            <li><strong>Utilisateurs :</strong> ajoutez managers et employés depuis <a href="${usersUrl}">Utilisateurs</a>.</li>
            <li><strong>Validation finale :</strong> connectez-vous ensuite au <a href="${dashboardUrl}">dashboard</a> et faites une première demande test.</li>
          </ol>
          <p>Si vous préférez, commencez directement par le tableau de bord : <a href="${dashboardUrl}">${dashboardUrl}</a></p>
        `,
      }
    );
  }

  async sendSuperAdminNotification(entreprise, admin) {
    const superAdmin = await Utilisateur.findOne({ where: { role: 'super_admin' } });
    if (!superAdmin) return;

    return this.sendEmail(
      superAdmin.email,
      'Nouvelle inscription entreprise en attente',
      'superadmin-notification',
      {
        entreprise_nom: entreprise.nom,
        admin_nom: `${admin.prenom} ${admin.nom}`,
        admin_email: admin.email,
        created_at: new Date().toLocaleDateString('fr-FR'),
        validation_url: `${getFrontendUrl()}/superadmin/companies`,
        content: `
          <p>Bonjour ${superAdmin.prenom || 'Super admin'},</p>
          <p>Une nouvelle entreprise vient de s'inscrire sur ${process.env.EMAIL_NAME || 'TeamOff'}.</p>
          <p><strong>Entreprise :</strong> ${entreprise.nom}</p>
          <p><strong>Administrateur :</strong> ${admin.prenom} ${admin.nom}</p>
          <p><strong>Email administrateur :</strong> ${admin.email}</p>
          <p><strong>Date :</strong> ${new Date().toLocaleString('fr-FR')}</p>
          <p>Consultez la liste des entreprises ici : <a href="${getFrontendUrl()}/superadmin/companies">${getFrontendUrl()}/superadmin/companies</a></p>
        `,
      }
    );
  }

  async sendPasswordReset(email, resetToken) {
    return this.sendEmail(
      email,
      'Réinitialisation de votre mot de passe',
      'password-reset',
      {
        reset_url: `${getFrontendUrl()}/reset-password/${resetToken}`,
        expiry_hours: 1,
      }
    );
  }

  async sendPasswordResetConfirmation(email) {
    return this.sendEmail(
      email,
      'Mot de passe mis à jour',
      'password-reset-confirmation',
      { login_url: `${getFrontendUrl()}/login` }
    );
  }

  async sendNewUserInvitation(email, temporaryPassword, inviterName) {
    return this.sendEmail(
      email,
      'Vous avez été invité à rejoindre TeamOff',
      'user-invitation',
      {
        inviter_nom: inviterName,
        email,
        password_temporaire: temporaryPassword,
        login_url: `${getFrontendUrl()}/login`,
      }
    );
  }

  async sendMonthlyReport(email, reportData, entreprise = null) {
    try {
      // Si aucune entreprise n'est fournie, la recuperer depuis l'utilisateur
      if (!entreprise) {
        const user = await Utilisateur.findOne({ where: { email } });
        if (!user) throw new Error(`Utilisateur introuvable pour l'email ${email}`);

        entreprise = await Entreprise.findByPk(user.entreprise_id);
        if (!entreprise) throw new Error(`Entreprise introuvable pour l'utilisateur ${email}`);
      }

      // Préparer le contenu de l'email
      const topAbsences = Array.isArray(reportData.top_absences) ? reportData.top_absences : [];

      return this.sendEmail(
        email,
        `Rapport mensuel de ${reportData.mois} ${reportData.annee}`,
        'monthly-report',
        {
          entreprise_nom: entreprise.nom,
          mois: reportData.mois,
          annee: reportData.annee,
          total_conges: reportData.total_conges,
          total_employes: reportData.total_employes,
          taux_absenteeisme: reportData.taux_absenteeisme,
          top_absences: topAbsences.join(', '),
        }
      );
    } catch (error) {
      logger.error('email_monthly_report_error', { error: error.message });
      throw error;
    }
  }

  async sendAlertEmail(email, alert) {
    const severityColors = {
      low: '#f59e0b',    // orange
      medium: '#f97316', // orange-500
      high: '#dc2626'    // red-600
    };

    const severityText = {
      low: 'Faible',
      medium: 'Moyen',
      high: 'Élevé'
    };

    return this.sendEmail(
      email,
      `Alerte système - Sévérité ${severityText[alert.severity]}`,
      'system-alert',
      {
        severity: severityText[alert.severity],
        severity_color: severityColors[alert.severity],
        alert_type: alert.type,
        message: alert.message,
        timestamp: new Date().toLocaleString('fr-FR'),
        dashboard_url: `${getFrontendUrl()}/dashboard`,
      }
    );
  }

  // ---------------------------
  // Rappel congé à venir (J-3 / J-1)
  // ---------------------------
  async sendLeaveReminder(conge, utilisateur, joursAvant) {
    const delaiLabel = joursAvant === 1 ? 'demain' : `dans ${joursAvant} jours`;
    return this.sendEmail(
      utilisateur.email,
      `Rappel : votre congé commence ${delaiLabel}`,
      'leave-reminder',
      {
        destinataire_prenom: utilisateur.prenom || 'Collaborateur',
        type_conge: conge.conge_type?.libelle || 'Congé',
        delai_label: delaiLabel,
        date_debut: conge.date_debut,
        date_fin: conge.date_fin,
        jours_calcules: conge.jours_calcules || '?',
        action_url: `${getFrontendUrl()}/dashboard`,
      }
    );
  }

  // ---------------------------
  // Compte bloqué après trop de tentatives
  // ---------------------------
  async sendAccountLocked(user, nbTentatives) {
    return this.sendEmail(
      user.email,
      'Votre compte a été temporairement bloqué',
      'account-locked',
      {
        destinataire_prenom: user.prenom || 'Utilisateur',
        nb_tentatives: nbTentatives,
        reset_url: `${getFrontendUrl()}/forgot-password`,
      }
    );
  }

  // ---------------------------
  // Solde de congés faible après validation
  // ---------------------------
  async sendLowBalance(utilisateur, typeConge, soldeRestant, annee) {
    return this.sendEmail(
      utilisateur.email,
      `Solde faible : il vous reste ${soldeRestant} jour(s) de ${typeConge}`,
      'low-balance',
      {
        destinataire_prenom: utilisateur.prenom || 'Collaborateur',
        type_conge: typeConge,
        solde_restant: soldeRestant,
        annee: annee || new Date().getFullYear(),
        action_url: `${getFrontendUrl()}/dashboard`,
      }
    );
  }

  // ---------------------------
  // Relance demande en attente (cron)
  // ---------------------------
  async sendLeavePendingReminder(conge, manager, joursAttente) {
    return this.sendEmail(
      manager.email,
      `Rappel : demande de congé en attente depuis ${joursAttente} jour(s)`,
      'leave-pending-reminder',
      {
        destinataire_prenom: manager.prenom || 'Manager',
        demandeur_nom: `${conge.utilisateur?.prenom || ''} ${conge.utilisateur?.nom || ''}`.trim(),
        type_conge: conge.conge_type?.libelle || 'Congé',
        date_debut: conge.date_debut,
        date_fin: conge.date_fin,
        jours_calcules: conge.jours_calcules || '?',
        jours_attente: joursAttente,
        date_soumission: new Date(conge.created_at).toLocaleDateString('fr-FR'),
        action_url: `${getFrontendUrl()}/conges`,
      }
    );
  }

  // ---------------------------
  // Réactivation compte utilisateur
  // ---------------------------
  async sendAccountReactivated(utilisateur) {
    return this.sendEmail(
      utilisateur.email,
      'Votre compte a été réactivé',
      'account-reactivated',
      {
        destinataire_prenom: utilisateur.prenom || 'Utilisateur',
        login_url: `${getFrontendUrl()}/login`,
      }
    );
  }

  // ---------------------------
  // Suspension entreprise
  // ---------------------------
  async sendEnterpriseSuspended(admin, entreprise) {
    return this.sendEmail(
      admin.email,
      `Compte entreprise suspendu : ${entreprise.nom}`,
      'enterprise-suspended',
      {
        destinataire_prenom: admin.prenom || 'Administrateur',
        entreprise_nom: entreprise.nom,
        support_email: process.env.SUPPORT_EMAIL || process.env.EMAIL_FROM || 'support@teamoff.fr',
      }
    );
  }

  // ---------------------------
  // Relance invitation non acceptée (cron)
  // ---------------------------
  async sendInvitationReminder(utilisateur, entreprise, joursSince) {
    return this.sendEmail(
      utilisateur.email,
      `Rappel : votre invitation ${entreprise?.nom || ''} vous attend`,
      'invitation-reminder',
      {
        destinataire_prenom: utilisateur.prenom || 'Utilisateur',
        entreprise_nom: entreprise?.nom || '',
        email: utilisateur.email,
        jours_depuis: joursSince,
        reset_url: `${getFrontendUrl()}/forgot-password`,
      }
    );
  }

  async sendWelcomeAfterActivation(user) {
    const dashboardUrl = `${getFrontendUrl()}/dashboard`;
    return this.sendEmail(
      user.email,
      `Bienvenue sur ${process.env.EMAIL_NAME || 'TeamOff'} !`,
      'welcome-activated',
      {
        prenom: user.prenom,
        nom: user.nom,
        dashboard_url: dashboardUrl,
        content: `
          <p>Bonjour ${user.prenom} ${user.nom},</p>
          <p>Votre compte est maintenant actif ! Vous pouvez vous connecter et commencer à utiliser ${process.env.EMAIL_NAME || 'TeamOff'}.</p>
          <p><a href="${dashboardUrl}">Accéder à mon espace</a></p>
        `,
      }
    );
  }

  async sendWeeklyManagerSummary(manager, conges, startOfWeek, endOfWeek) {
    const dayjs = require('dayjs');
    const rows = conges.map((c) => {
      const name = `${c.utilisateur?.prenom || ''} ${c.utilisateur?.nom || ''}`.trim();
      const service = c.utilisateur?.service || '-';
      const type = c.conge_type?.libelle || 'Congé';
      return `<tr><td style="padding:8px;border-bottom:1px solid #e5e7eb">${name}</td><td style="padding:8px;border-bottom:1px solid #e5e7eb">${service}</td><td style="padding:8px;border-bottom:1px solid #e5e7eb">${type}</td><td style="padding:8px;border-bottom:1px solid #e5e7eb">${c.date_debut}</td><td style="padding:8px;border-bottom:1px solid #e5e7eb">${c.date_fin}</td></tr>`;
    }).join('');

    const periode = `${dayjs(startOfWeek).format('DD/MM')} – ${dayjs(endOfWeek).format('DD/MM/YYYY')}`;

    return this.sendEmail(
      manager.email,
      `Résumé de la semaine — ${conges.length} congé(s) à venir`,
      'weekly-manager-summary',
      {
        prenom: manager.prenom,
        nom: manager.nom,
        periode,
        total: String(conges.length),
        table_rows: rows,
        dashboard_url: `${getFrontendUrl()}/conges`,
        content: `<p>Bonjour ${manager.prenom},</p><p>${conges.length} congé(s) validé(s) pour la semaine ${periode}.</p>`,
      }
    );
  }
}

module.exports = new EmailService();