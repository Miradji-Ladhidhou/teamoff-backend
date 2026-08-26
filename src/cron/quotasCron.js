const cron = require('node-cron');
const logger = require('../utils/logger');
const quotasService = require('../services/quotasService');
const { tryActivateReservations } = require('../services/congesService');
const { Entreprise, Conge } = require('../models');

/**
 * Tente d'activer toutes les réservations 'reserve' pour une entreprise.
 * Appelée après chaque crédit de compteur (mensuel, annuel).
 */
async function tryActivateCompanyReservations(entrepriseId) {
  const pending = await Conge.findAll({
    attributes: ['utilisateur_id', 'conge_type_id', 'date_debut'],
    where: { entreprise_id: entrepriseId, statut: 'reserve' },
    raw: true,
  });

  const seen = new Set();
  for (const row of pending) {
    const annee = new Date(row.date_debut).getFullYear();
    const key = `${row.utilisateur_id}::${row.conge_type_id}::${annee}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const result = await tryActivateReservations(row.utilisateur_id, row.conge_type_id, annee);
    if (result.activated.length > 0) {
      logger.info(
        `[quotas-cron] ${result.activated.length} réservation(s) activée(s) pour utilisateur=${row.utilisateur_id} type=${row.conge_type_id} année=${annee}`
      );
    }
    if (result.error) {
      logger.error(`[quotas-cron] Erreur activation réservations:`, { error: result.error });
    }
  }
}

async function processAllEnterprises(handler) {
  const entreprises = await Entreprise.findAll({
    attributes: ['id', 'nom', 'statut'],
    where: { statut: 'active' },
  });

  for (const entreprise of entreprises) {
    try {
      await handler(entreprise);
    } catch (err) {
      logger.error(`[quotas-cron] Erreur pour entreprise ${entreprise.nom} (${entreprise.id}):`, err);
      // Continue avec les autres entreprises
    }
  }
}

async function runAnnualInit() {
  const year = new Date().getFullYear();
  logger.info(`[quotas-cron] Initialisation des compteurs pour ${year}...`);

  await processAllEnterprises(async (entreprise) => {
    await quotasService.initQuotaAnnuel(entreprise.id, year);
    logger.info(`[quotas-cron] Initialisation OK: ${entreprise.nom} (${entreprise.id})`);
    await tryActivateCompanyReservations(entreprise.id);
  });
}

async function runMonthlyAccrual() {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  logger.info(`[quotas-cron] Crédit mensuel ${year}-${String(month).padStart(2, '0')}...`);

  await processAllEnterprises(async (entreprise) => {
    const result = await quotasService.ajouterAcquisitionMensuelle(entreprise.id, year, month);
    logger.info(
      `[quotas-cron] Crédit OK: ${entreprise.nom} (${entreprise.id}) - appliqués=${result.applied}, ignorés=${result.skipped}, ajouté=${result.total_added}`
    );
    await tryActivateCompanyReservations(entreprise.id);
  });
}

function initQuotasCron() {
  // Chaque 1er janvier à 00:00
  cron.schedule('0 0 1 1 *', async () => {
    try {
      await runAnnualInit();
    } catch (error) {
      logger.error('[quotas-cron] Erreur initialisation annuelle:', error);
    }
  });

  // Chaque 1er du mois (fév-déc) à 00:05
  cron.schedule('5 0 1 2-12 *', async () => {
    try {
      await runMonthlyAccrual();
    } catch (error) {
      logger.error('[quotas-cron] Erreur crédit mensuel:', error);
    }
  });

  // 1er janvier à 02:05 — après runAnnualInit (00:00), délai de 2h pour les grandes instances
  cron.schedule('5 2 1 1 *', async () => {
    try {
      await runMonthlyAccrual();
    } catch (error) {
      logger.error('[quotas-cron] Erreur crédit mensuel (janvier):', error);
    }
  });

  logger.info('[quotas-cron] Planification activée');
}

module.exports = {
  initQuotasCron,
  runAnnualInit,
  runMonthlyAccrual,
};