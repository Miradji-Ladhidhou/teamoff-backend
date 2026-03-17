#!/usr/bin/env node

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const { sequelize, Entreprise } = require('../src/models');

async function cleanGhostServices() {
  try {
    await sequelize.authenticate();
    console.log('🧹 Nettoyage des services fantômes\n');

    const enterprises = await Entreprise.findAll();
    let totalCleaned = 0;

    for (const enterprise of enterprises) {
      const policy = enterprise.politique_conges || {};
      const validServices = Object.keys(policy.service_policies || {});
      const ghostServices = Object.keys(policy.max_employees_on_leave?.by_service || {}).filter(
        (service) => !validServices.includes(service)
      );

      if (ghostServices.length > 0) {
        console.log(`\n📋 ${enterprise.nom}`);
        console.log(`   Services fantômes trouvés: ${ghostServices.join(', ')}`);

        // Supprimer les services fantômes
        for (const ghostService of ghostServices) {
          delete policy.max_employees_on_leave.by_service[ghostService];
          totalCleaned++;
          console.log(`   ✓ Supprimé: "${ghostService}"`);
        }

        // Sauvegarder les changements
        enterprise.politique_conges = policy;
        await enterprise.save();
        console.log(`   ✓ Politique mise à jour`);
      }
    }

    console.log(`\n✅ Résumé:`);
    console.log(`   Services fantômes supprimés: ${totalCleaned}`);
    console.log(`\n✓ Nettoyage terminé! Vous pouvez maintenant supprimer les services depuis la page Services.\n`);

    await sequelize.close();
  } catch (err) {
    console.error('✗ Erreur:', err.message);
    process.exit(1);
  }
}

cleanGhostServices();
