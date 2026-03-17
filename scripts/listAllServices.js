#!/usr/bin/env node

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const { sequelize, Utilisateur, Entreprise } = require('../src/models');

async function listServices() {
  try {
    await sequelize.authenticate();
    console.log('Services par entreprise:\n');

    const enterprises = await Entreprise.findAll({ attributes: ['id', 'nom', 'politique_conges'] });

    for (const enterprise of enterprises) {
      const policy = enterprise.politique_conges || {};
      const services = Object.keys(policy.service_policies || {});
      
      console.log(`📦 ${enterprise.nom}`);
      
      if (services.length === 0) {
        console.log('   ⚠️  Aucun service configuré');
      } else {
        console.log(`   Services (${services.length}):`);
        for (const service of services) {
          const userCount = await Utilisateur.count({
            where: { entreprise_id: enterprise.id, service }
          });
          console.log(`   - "${service}" → ${userCount} utilisateur(s)`);
        }
      }
      console.log('');
    }

    await sequelize.close();
  } catch (err) {
    console.error('✗ Erreur:', err.message);
    process.exit(1);
  }
}

listServices();
