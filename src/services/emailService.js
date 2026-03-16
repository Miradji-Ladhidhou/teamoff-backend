const nodemailer = require('nodemailer');
const fs = require('fs').promises;
const path = require('path');
const { Utilisateur, Entreprise } = require('../models');
const systemSettingsService = require('./systemSettingsService');

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

  createTransporter(smtpConfig) {
    return nodemailer.createTransport({
      host: smtpConfig.host,
      port: Number(smtpConfig.port),
      secure: Boolean(smtpConfig.secure),
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

  // Méthode générique d'envoi d'email
  async sendEmail(to, subject, templateName, data = {}) {
    try {
      const smtpConfig = await this.getSmtpConfig();

      if (!smtpConfig.host || !smtpConfig.user || !smtpConfig.pass) {
        throw new Error('Configuration SMTP incomplete (host/user/pass requis).');
      }

      let html;
      try {
        const templatePath = path.join(__dirname, '../templates/emails', `${templateName}.html`);
        html = await fs.readFile(templatePath, 'utf8');
      } catch {
        html = await this.getDefaultTemplate();
      }

      html = this.replaceTemplateVariables(html, data);

      const mailOptions = {
        from: `"${process.env.EMAIL_NAME}" <${smtpConfig.from || smtpConfig.user}>`,
        to,
        subject,
        html,
        text: this.htmlToText(html),
      };

      if (process.env.MAIL_SIMULATE === 'true') {
        console.log('📧 Email simulé:', { to, subject, data });
        return { success: true, test: true };
      }

      const transporter = this.createTransporter(smtpConfig);
      const info = await transporter.sendMail(mailOptions);
      console.log(`📧 Email envoyé à ${to}: ${info.messageId}`);
      return { success: true, messageId: info.messageId };
    } catch (error) {
      console.error('❌ Erreur envoi email:', error);
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
      frontend_url: process.env.FRONTEND_URL || 'http://localhost:3000',
    };

    Object.keys(globals).forEach(key => {
      html = html.replace(new RegExp(`{{${key}}}`, 'g'), globals[key]);
    });

    return html;
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

  async sendWelcomeEmail(user, entreprise, temporaryPassword) {
    const entrepriseNom = entreprise?.nom || 'Votre entreprise';
    const loginUrl = `${process.env.FRONTEND_URL}/login`;

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
        change_password_url: `${process.env.FRONTEND_URL}/reset-password`,
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
        dashboard_url: `${process.env.FRONTEND_URL}/super-admin/entreprises`,
        content: `
          <p>Bonjour ${nomComplet},</p>
          <p>L'entreprise <strong>${entreprise.nom}</strong> a été créée avec le statut <strong>${entreprise.statut}</strong>.</p>
          <p>Vous pouvez la gérer depuis votre espace super administrateur.</p>
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
        validation_url: `${process.env.FRONTEND_URL}/super-admin/entreprises/${entreprise.id}`,
      }
    );
  }

  async sendPasswordReset(email, resetToken) {
    return this.sendEmail(
      email,
      'Réinitialisation de votre mot de passe',
      'password-reset',
      {
        reset_url: `${process.env.FRONTEND_URL}/reset-password/${resetToken}`,
        expiry_hours: 1,
      }
    );
  }

  async sendPasswordResetConfirmation(email) {
    return this.sendEmail(
      email,
      'Mot de passe mis à jour',
      'password-reset-confirmation',
      { login_url: `${process.env.FRONTEND_URL}/login` }
    );
  }

  async sendNewLeaveRequest(conge, manager) {
    return this.sendEmail(
      manager.email,
      'Nouvelle demande de congé à valider',
      'new-leave-request',
      {
        employe_nom: `${conge.utilisateur.prenom} ${conge.utilisateur.nom}`,
        dates: `${conge.date_debut} au ${conge.date_fin}`,
        type_conge: conge.conge_type.libelle,
        jours_pris: conge.jours_calcules || '?',
        commentaire: conge.commentaire_employe || 'Aucun commentaire',
        validation_url: `${process.env.FRONTEND_URL}/manager/approvals`,
        delai_jours: 7,
      }
    );
  }

  async sendLeaveStatusUpdate(conge, employee, status) {
    const subject = status === 'valide'
      ? 'Votre demande de congé a été approuvée'
      : 'Votre demande de congé a été refusée';

    return this.sendEmail(
      employee.email,
      subject,
      'leave-status-update',
      {
        prenom: employee.prenom,
        statut: status,
        dates: `${conge.date_debut} au ${conge.date_fin}`,
        type_conge: conge.conge_type.libelle,
        commentaire: conge.commentaire_manager || conge.commentaire_admin || 'Aucun commentaire',
        solde_restant_conges: employee.solde_conges,
        solde_restant_rtt: employee.solde_rtt,
        dashboard_url: `${process.env.FRONTEND_URL}/employee/dashboard`,
      }
    );
  }

  async sendLeaveCancellation(conge, employee, cancelledBy) {
    return this.sendEmail(
      employee.email,
      'Votre congé a été annulé',
      'leave-cancellation',
      {
        prenom: employee.prenom,
        annule_par: cancelledBy,
        dates: `${conge.date_debut} au ${conge.date_fin}`,
        type_conge: conge.conge_type.libelle,
        raison: conge.commentaire_rh || conge.commentaire_manager || 'Non spécifiée',
        solde_restant_conges: employee.solde_conges,
        solde_restant_rtt: employee.solde_rtt,
        dashboard_url: `${process.env.FRONTEND_URL}/employee/dashboard`,
      }
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
        login_url: `${process.env.FRONTEND_URL}/login`,
      }
    );
  }

  async sendMonthlyReport(email, reportData, entreprise = null) {
    try {
      // Si aucune entreprise n’est fournie, la récupérer depuis l’utilisateur
      if (!entreprise) {
        const user = await Utilisateur.findOne({ where: { email } });
        if (!user) throw new Error(`Utilisateur introuvable pour l'email ${email}`);

        const EntrepriseModel = require('../models/Entreprise')(user.sequelize); // s'assure que le modèle existe
        entreprise = await EntrepriseModel.findByPk(user.entreprise_id);
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
      console.error('❌ Erreur envoi rapport mensuel:', error);
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
        dashboard_url: `${process.env.FRONTEND_URL}/admin/dashboard`,
      }
    );
  }
}

module.exports = new EmailService();