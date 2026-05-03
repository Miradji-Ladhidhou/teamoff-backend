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
// Relance demandes en attente depuis > 3 jours
// ---------------------------------------------------------------------------
async function runPendingLeaveReminders() {
  const threshold = dayjs().subtract(3, 'day').toDate();

  const conges = await Conge.findAll({
    where: {
      statut: 'en_attente',
      created_at: { [Op.lte]: threshold },
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
        statut: { [Op.in]: ['valide', 'annule'] },
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
      total_valides: conges.filter((c) => c.statut === 'valide').length,
      total_annules: conges.filter((c) => c.statut === 'annule').length,
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
// Relance invitations non acceptées (jamais connecté depuis > 3 jours)
// ---------------------------------------------------------------------------
async function runInvitationReminders() {
  // J+1 window: created between 20h and 28h ago
  const j1Start = dayjs().subtract(28, 'hour').toDate();
  const j1End = dayjs().subtract(20, 'hour').toDate();

  // J+3 and beyond
  const threshold3 = dayjs().subtract(3, 'day').toDate();

  const [utilisateursJ1, utilisateursJ3] = await Promise.all([
    Utilisateur.findAll({
      where: {
        statut: 'en_attente',
        last_login: null,
        invite_token_hash: { [Op.ne]: null },
        created_at: { [Op.between]: [j1Start, j1End] },
      },
      attributes: ['id', 'email', 'prenom', 'nom', 'entreprise_id', 'created_at'],
    }),
    Utilisateur.findAll({
      where: {
        statut: 'en_attente',
        last_login: null,
        invite_token_hash: { [Op.ne]: null },
        created_at: { [Op.lte]: threshold3 },
      },
      attributes: ['id', 'email', 'prenom', 'nom', 'entreprise_id', 'created_at'],
    }),
  ]);

  for (const utilisateur of [...utilisateursJ1, ...utilisateursJ3]) {
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

  logger.info('[email-cron] Planification emails automatiques activée');
}

module.exports = {
  initEmailCron,
  runLeaveReminders,
  runPendingLeaveReminders,
  runMonthlyReports,
  runInvitationReminders,
  runWeeklyManagerSummary,
};
