// src/test/test-mails.js
require('dotenv').config();
const EmailService = require('../services/emailService');

async function testEmails() {
  try {
    console.log('📧 Test de tous les emails...');

    // ----- Utilisateurs et entreprise fictifs -----
    const user = {
      prenom: 'Jean',
      nom: 'Dupont',
      email: process.env.SUPER_ADMIN_EMAIL || 'saas.teamoff@gmail.com',
      id: 'user-123',
      solde_conges: 12,
      solde_rtt: 5,
      password_temporaire: 'MotDePasseTemp123!',
    };

    const entreprise = {
      nom: 'TeamOff Test',
      id: 'entreprise-123',
    };

    const admin = {
      prenom: 'Alice',
      nom: 'Martin',
      email: process.env.SUPER_ADMIN_EMAIL || 'admin@example.com',
    };

    // ----- Demande de congé fictive -----
    const conge = {
      utilisateur: user,
      conge_type: { libelle: 'RTT' },
      date_debut: '2026-03-15',
      date_fin: '2026-03-17',
      jours_calcules: 2,
      commentaire_employe: 'Vacances',
      commentaire_manager: 'OK',
      commentaire_rh: '',
    };

    const resetToken = 'token123456';

    // ----- 1. Email de bienvenue -----
    await EmailService.sendWelcomeEmail(user, entreprise, user.password_temporaire);

    // ----- 2. Notification super admin -----
    await EmailService.sendSuperAdminNotification(entreprise, admin);

    // ----- 3. Email réinitialisation mot de passe -----
    await EmailService.sendPasswordReset(user.email, resetToken);

    // ----- 4. Confirmation mot de passe -----
    await EmailService.sendPasswordResetConfirmation(user.email);

    // ----- 5. Nouvelle demande de congé -----
    await EmailService.sendNewLeaveRequest(conge, admin);

    // ----- 6. Statut congé (valide) -----
    await EmailService.sendLeaveStatusUpdate(conge, user, 'valide');

    // ----- 7. Annulation congé -----
    await EmailService.sendLeaveCancellation(conge, user, 'manager');

    // ----- 8. Invitation nouvel utilisateur -----
    await EmailService.sendNewUserInvitation(user.email, user.password_temporaire, admin.nom);

    // ----- 9. Rapport mensuel -----
    await EmailService.sendMonthlyReport(
      user.email,
      {
        mois: 'Mars',
        annee: 2026,
        total_conges: 15,
        total_employes: 10,
        taux_absenteeisme: 5,
        top_absences: ['Jean', 'Alice'],
      },
      entreprise
    );

    console.log('✅ Tous les emails ont été testés avec succès (logs si NODE_ENV=development)');
  } catch (err) {
    console.error('❌ Erreur test emails :', err);
  } finally {
    process.exit(0);
  }
}

testEmails();