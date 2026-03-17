#!/usr/bin/env node

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const { sequelize, Entreprise } = require('../src/models');

async function inspectAndCleanPolicies() {
  try {
    await sequelize.authenticate();
    console.log('Inspection détaillée des politiques de congés\n');

    const enterprises = await Entreprise.findAll();

    for (const enterprise of enterprises) {
      console.log(`\n📋 ${enterprise.nom}`);
      console.log('='.repeat(60));
      
      const policy = enterprise.politique_conges || {};
      const serviceCount = Object.keys(policy.service_policies || {}).length;
      
      console.log(`Services configurés: ${serviceCount}`);
      
      if (Object.keys(policy.service_policies || {}).length > 0) {
        console.log('\nServices trouvés:');
        for (const [serviceName, servicePolicy] of Object.entries(policy.service_policies || {})) {
          console.log(`  - "${serviceName}"`);
          console.log(`    ${JSON.stringify(servicePolicy, null, 4).split('\n').slice(1, -1).join('\n    ')}`);
        }
      } else {
        console.log('ℹ️  Aucun service configuré');
      }

      // Vérifier si policy est vide entièrement
      console.log('\n📊 Structure de la politique:');
      console.log(JSON.stringify(policy, null, 2).split('\n').slice(0, 20).join('\n'));
    }

    console.log('\n'. repeat(60));
    console.log('\n> Pour nettoyer un service fantôme, utilisez le script cleanGhostServices.js');

    await sequelize.close();
  } catch (err) {
    console.error('✗ Erreur:', err.message);
    process.exit(1);
  }
}

inspectAndCleanPolicies();
