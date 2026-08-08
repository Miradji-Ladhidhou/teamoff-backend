const cron = require('node-cron');
const dayjs = require('dayjs');
const { Op } = require('sequelize');
const { Conge, Utilisateur, Entreprise, CompteurConges, CongeType } = require('../models');
const emailService = require('../services/emailService');
const logger = require('../utils/logger');

// ---------------------------------------------------------------------------
// Rappels congés à venir (J-3 et J-1)
// ---------------------------------------------------------------------------
async function runLeaveReminders() {
  const today = dayjs().format('YYYY-MM-DD');
  const in1 = dayjs().add(1, 'day').format('YYYY-MM-DD');
  const in3 = dayjs().add(3, 'day').format('YYYY-MM-DD');

  const targetDates = [in1, in3];

  for (const targetDate of targetDates) {
    const joursAvant = dayjs(targetDate).diff(dayjs(today), 'day');

    const conges = await Conge.findAll({
      where: {
        date_debut: targetDate,
        statut: 'valide',
      },
      include: [
        { model: Utilisateur, as: 'utilisateur', attributes: ['id', 'email', 'prenom', 'nom'] },
        { model: CongeType, as: 'conge_type', attributes: ['libelle'] },
      ],
    });

    for (const conge of conges) {
      if (!conge.utilisateur?.email) continue;
      try {
        await emailService.sendLeaveReminder(conge, conge.utilisateur, joursAvant);
        logger.info(`[email-cron] Rappel congé J-${joursAvant} envoyé à ${conge.utilisateur.email}`);
      } catch (e) {
        logger.error('[email-cron] sendLeaveReminder error', { error: e.message, congeId: conge.id });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Relance demandes en attente : exactement J+3 et J+7
// Fenêtre glissante de 24h par palier — borne naturelle à 2 relances max.
// (Item #61 : idempotence garantie par la fenêtre ; un double-run le même jour
//  enverrait deux fois, cas adressable par un flag DB si besoin.)
// ---------------------------------------------------------------------------
async function runPendingLeaveReminders() {
  // Fenêtre J+3 : created_at entre 4 j et 3 j ago
  const j3End   = dayjs().subtract(3, 'day').toDate();
  const j3Start = dayjs().subtract(4, 'day').toDate();
  // Fenêtre J+7 : created_at entre 8 j et 7 j ago
  const j7End   = dayjs().subtract(7, 'day').toDate();
  const j7Start = dayjs().subtract(8, 'day').toDate();

  const conges = await Conge.findAll({
    where: {
      statut: 'en_attente_manager',
      [Op.or]: [
        { created_at: { [Op.gt]: j3Start, [Op.lte]: j3End } },
        { created_at: { [Op.gt]: j7Start, [Op.lte]: j7End } },
      ],
    },
    include: [
      { model: Utilisateur, as: 'utilisateur', attributes: ['id', 'email', 'prenom', 'nom', 'entreprise_id', 'service'] },
      { model: CongeType, as: 'conge_type', attributes: ['libelle'] },
    ],
  });

  for (const conge of conges) {
    if (!conge.utilisateur) continue;
    const joursAttente = dayjs().diff(dayjs(conge.created_at), 'day');

    // Trouver le manager du même service
    const managers = await Utilisateur.findAll({
      where: {
        entreprise_id: conge.utilisateur.entreprise_id,
        role: 'manager',
        service: conge.utilisateur.service || null,
        statut: 'actif',
      },
      attributes: ['id', 'email', 'prenom', 'nom'],
    });

    // Fallback : tous les managers de l'entreprise
    const recipients = managers.length > 0 ? managers : await Utilisateur.findAll({
      where: {
        entreprise_id: conge.utilisateur.entreprise_id,
        role: { [Op.in]: ['manager', 'admin_entreprise'] },
        statut: 'actif',
      },
      attributes: ['id', 'email', 'prenom', 'nom'],
    });

    for (const manager of recipients) {
      try {
        await emailService.sendLeavePendingReminder(conge, manager, joursAttente);
        logger.info(`[email-cron] Relance demande en attente → ${manager.email} (congé ${conge.id})`);
      } catch (e) {
        logger.error('[email-cron] sendLeavePendingReminder error', { error: e.message, congeId: conge.id });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Rapport mensuel automatique (admins entreprise)
// ---------------------------------------------------------------------------
async function runMonthlyReports() {
  const now = dayjs();
  const year = now.year();
  const month = now.month() + 1;
  const startOfLastMonth = now.subtract(1, 'month').startOf('month').toDate();
  const endOfLastMonth = now.subtract(1, 'month').endOf('month').toDate();

  const entreprises = await Entreprise.findAll({
    where: { statut: 'active' },
    attributes: ['id', 'nom'],
  });

  for (const entreprise of entreprises) {
    const conges = await Conge.findAll({
      where: {
        entreprise_id: entreprise.id,
        date_debut: { [Op.between]: [startOfLastMonth, endOfLastMonth] },
        statut: 'valide_final',
      },
      include: [
        { model: Utilisateur, as: 'utilisateur', attributes: ['prenom', 'nom'] },
        { model: CongeType, as: 'conge_type', attributes: ['libelle'] },
      ],
    });

    const admins = await Utilisateur.findAll({
      where: { entreprise_id: entreprise.id, role: 'admin_entreprise', statut: 'actif' },
      attributes: ['id', 'email', 'prenom', 'nom'],
    });

    const reportData = {
      periode: now.subtract(1, 'month').format('MMMM YYYY'),
      total_conges: conges.length,
      total_valides: conges.length,
      total_annules: 0,
      total_jours: conges.reduce((s, c) => s + (c.jours_calcules || 0), 0),
    };

    for (const admin of admins) {
      try {
        await emailService.sendMonthlyReport(admin.email, reportData, entreprise);
        logger.info(`[email-cron] Rapport mensuel envoyé à ${admin.email} (${entreprise.nom})`);
      } catch (e) {
        logger.error('[email-cron] sendMonthlyReport error', { error: e.message, entrepriseId: entreprise.id });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Relance invitations non acceptées : J+1, J+3 et J+7 uniquement
// Chaque palier utilise une fenêtre glissante de 24h — borne à 3 relances max.
// ---------------------------------------------------------------------------
async function runInvitationReminders() {
  // J+1 : créé entre 20h et 28h ago (fenêtre inchangée)
  const j1Start = dayjs().subtract(28, 'hour').toDate();
  const j1End   = dayjs().subtract(20, 'hour').toDate();

  // J+3 : créé entre 4 j et 3 j ago
  const j3Start = dayjs().subtract(4, 'day').toDate();
  const j3End   = dayjs().subtract(3, 'day').toDate();

  // J+7 : créé entre 8 j et 7 j ago
  const j7Start = dayjs().subtract(8, 'day').toDate();
  const j7End   = dayjs().subtract(7, 'day').toDate();

  const baseWhere = {
    statut: 'en_attente',
    last_login: null,
    invite_token_hash: { [Op.ne]: null },
  };

  const [utilisateursJ1, utilisateursJ3, utilisateursJ7] = await Promise.all([
    Utilisateur.findAll({
      where: { ...baseWhere, created_at: { [Op.gt]: j1Start, [Op.lte]: j1End } },
      attributes: ['id', 'email', 'prenom', 'nom', 'entreprise_id', 'created_at'],
    }),
    Utilisateur.findAll({
      where: { ...baseWhere, created_at: { [Op.gt]: j3Start, [Op.lte]: j3End } },
      attributes: ['id', 'email', 'prenom', 'nom', 'entreprise_id', 'created_at'],
    }),
    Utilisateur.findAll({
      where: { ...baseWhere, created_at: { [Op.gt]: j7Start, [Op.lte]: j7End } },
      attributes: ['id', 'email', 'prenom', 'nom', 'entreprise_id', 'created_at'],
    }),
  ]);

  for (const utilisateur of [...utilisateursJ1, ...utilisateursJ3, ...utilisateursJ7]) {
    const entreprise = await Entreprise.findByPk(utilisateur.entreprise_id, { attributes: ['id', 'nom'] });
    const joursSince = dayjs().diff(dayjs(utilisateur.created_at), 'day');
    try {
      await emailService.sendInvitationReminder(utilisateur, entreprise, joursSince);
      logger.info(`[email-cron] Relance invitation → ${utilisateur.email} (J+${joursSince})`);
    } catch (e) {
      logger.error('[email-cron] sendInvitationReminder error', { error: e.message, userId: utilisateur.id });
    }
  }
}

// ---------------------------------------------------------------------------
// Résumé hebdomadaire managers
// ---------------------------------------------------------------------------
async function runWeeklyManagerSummary() {
  const startOfWeek = dayjs().startOf('week').add(1, 'day').toDate(); // lundi
  const endOfWeek = dayjs().startOf('week').add(7, 'day').toDate();   // dimanche

  const managers = await Utilisateur.findAll({
    where: { role: 'manager', statut: 'actif' },
    attributes: ['id', 'email', 'prenom', 'nom', 'entreprise_id', 'service'],
  });

  for (const manager of managers) {
    try {
      const conges = await Conge.findAll({
        where: {
          entreprise_id: manager.entreprise_id,
          statut: 'valide_final',
          date_debut: { [Op.between]: [startOfWeek, endOfWeek] },
          ...(manager.service ? {} : {}),
        },
        include: [
          { model: Utilisateur, as: 'utilisateur', attributes: ['prenom', 'nom', 'service'] },
          { model: CongeType, as: 'conge_type', attributes: ['libelle'] },
        ],
      });

      if (conges.length === 0) continue;

      await emailService.sendWeeklyManagerSummary(manager, conges, startOfWeek, endOfWeek);
      logger.info(`[email-cron] Résumé hebdo → ${manager.email} (${conges.length} congés)`);
    } catch (e) {
      logger.error('[email-cron] sendWeeklyManagerSummary error', { error: e.message, managerId: manager.id });
    }
  }
}

// ---------------------------------------------------------------------------
// Rappels réservations de congés (J-30 et J-7 avant le départ)
// Idempotent : verrou par flag DB — un seul UPDATE WHERE IS NULL peut réussir,
// garantissant qu'une seule instance envoie le rappel en déploiement multi-nœud.
// ---------------------------------------------------------------------------
async function runReservationReminders() {
  const targets = [
    { days: 30, label: '30 jours', flagField: 'reminder_j30_sent_at' },
    { days: 7,  label: '7 jours',  flagField: 'reminder_j7_sent_at'  },
  ];

  for (const { days, label, flagField } of targets) {
    const targetDate = dayjs().add(days, 'day').format('YYYY-MM-DD');

    const reservations = await Conge.findAll({
      where: {
        statut: 'reserve',
        date_debut: targetDate,
        [flagField]: null,
      },
      include: [
        { model: Utilisateur, as: 'utilisateur', attributes: ['id', 'email', 'prenom', 'nom', 'entreprise_id'] },
        { model: CongeType, as: 'conge_type', attributes: ['libelle'] },
      ],
    });

    for (const conge of reservations) {
      if (!conge.utilisateur) continue;

      // Verrou atomique : seule l'instance qui pose le flag envoie l'email.
      // En cluster (PM2, K8s), les autres instances obtiennent rowsClaimed = 0.
      const [rowsClaimed] = await Conge.update(
        { [flagField]: new Date() },
        { where: { id: conge.id, [flagField]: null } }
      );
      if (rowsClaimed === 0) continue;

      const admins = await Utilisateur.findAll({
        where: {
          entreprise_id: conge.utilisateur.entreprise_id,
          role: { [Op.in]: ['admin_entreprise', 'manager'] },
          statut: 'actif',
        },
        attributes: ['id', 'email', 'prenom', 'nom'],
      });

      const demandeurNom = `${conge.utilisateur.prenom || ''} ${conge.utilisateur.nom || ''}`.trim();
      const actionUrl = `${process.env.FRONTEND_URL?.split(',')[0] || ''}/conges/${conge.id}`;

      for (const admin of admins) {
        try {
          await emailService.sendEmail(
            admin.email,
            `Rappel réservation congé dans ${label} - ${demandeurNom}`,
            'leave-reservation-reminder',
            {
              destinataire_prenom: admin.prenom || 'Responsable',
              demandeur_nom: demandeurNom,
              date_debut: conge.date_debut,
              date_fin: conge.date_fin,
              type_conge: conge.conge_type?.libelle || 'Congé',
              jours_calcules: conge.jours_calcules,
              jours_avant: days,
              action_url: actionUrl,
            }
          );
          logger.info(`[email-cron] Rappel réservation J-${days} → ${admin.email} (congé ${conge.id})`);
        } catch (e) {
          logger.error('[email-cron] sendReservationReminder error', { error: e.message, congeId: conge.id });
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Initialisation des crons
// ---------------------------------------------------------------------------
function initEmailCron() {
  // Rappels congés à venir — chaque jour à 08:00
  cron.schedule('0 8 * * *', async () => {
    try { await runLeaveReminders(); }
    catch (e) { logger.error('[email-cron] runLeaveReminders failed', { error: e.message }); }
  });

  // Relance demandes en attente — chaque jour à 09:00
  cron.schedule('0 9 * * *', async () => {
    try { await runPendingLeaveReminders(); }
    catch (e) { logger.error('[email-cron] runPendingLeaveReminders failed', { error: e.message }); }
  });

  // Rapport mensuel — le 1er du mois à 07:00
  cron.schedule('0 7 1 * *', async () => {
    try { await runMonthlyReports(); }
    catch (e) { logger.error('[email-cron] runMonthlyReports failed', { error: e.message }); }
  });

  // Relance invitations — chaque jour à 10:00
  cron.schedule('0 10 * * *', async () => {
    try { await runInvitationReminders(); }
    catch (e) { logger.error('[email-cron] runInvitationReminders failed', { error: e.message }); }
  });

  // Résumé hebdomadaire managers — chaque lundi à 07:00
  cron.schedule('0 7 * * 1', async () => {
    try { await runWeeklyManagerSummary(); }
    catch (e) { logger.error('[email-cron] runWeeklyManagerSummary failed', { error: e.message }); }
  });

  // Rappels réservations (J-30 et J-7) — chaque jour à 08:30
  cron.schedule('30 8 * * *', async () => {
    try { await runReservationReminders(); }
    catch (e) { logger.error('[email-cron] runReservationReminders failed', { error: e.message }); }
  });

  logger.info('[email-cron] Planification emails automatiques activée');
}

module.exports = {
  initEmailCron,
  runLeaveReminders,
  runPendingLeaveReminders,
  runMonthlyReports,
  runInvitationReminders,
  runWeeklyManagerSummary,
  runReservationReminders,
};
