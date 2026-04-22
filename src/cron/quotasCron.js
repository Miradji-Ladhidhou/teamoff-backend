const cron = require('node-cron');
const logger = require('../utils/logger');
const quotasService = require('../services/quotasService');
const { Entreprise } = require('../models');

async function processAllEnterprises(handler) {
  const entreprises = await Entreprise.findAll({
    attributes: ['id', 'nom', 'statut'],
    where: { statut: 'active' },
  });

  for (const entreprise of entreprises) {
    await handler(entreprise);
  }
}

async function runAnnualInit() {
  const year = new Date().getFullYear();
  logger.info(`[quotas-cron] Initialisation des compteurs pour ${year}...`);

  await processAllEnterprises(async (entreprise) => {
    await quotasService.initQuotaAnnuel(entreprise.id, year);
    logger.info(`[quotas-cron] Initialisation OK: ${entreprise.nom} (${entreprise.id})`);
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

  // Chaque 1er du mois à 00:00
  cron.schedule('0 0 1 * *', async () => {
    try {
      await runMonthlyAccrual();
    } catch (error) {
      logger.error('[quotas-cron] Erreur crédit mensuel:', error);
    }
  });

  logger.info('[quotas-cron] Planification activée');
}

module.exports = {
  initQuotasCron,
  runAnnualInit,
  runMonthlyAccrual,
};