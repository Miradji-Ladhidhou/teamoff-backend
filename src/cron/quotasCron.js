const cron = require('node-cron');
const quotasService = require('../services/quotasService');

// Chaque 1er janvier
cron.schedule('0 0 1 1 *', async () => {
  // itérer sur toutes les entreprises
  console.log('Initialisation quotas annuels...');
});

// Chaque 1er du mois
cron.schedule('0 0 1 * *', async () => {
  console.log('Ajout acquisition mensuelle...');
});