#!/usr/bin/env node
/**
 * Script de synchronisation BD sans perte de données
 * Applique les migrations via sequelize.sync()
 */

require('dotenv').config();

const { sequelize, LeavePolicy, Entreprise } = require('./src/models');

const syncDatabase = async () => {
  try {
    console.log('🔗 Connexion à la BD...');
    await sequelize.authenticate();
    console.log('✅ BD connectée\n');

    console.log('🔄 Synchronisation des modèles (alter: false = pas de perte de données)...');
    await sequelize.sync({ alter: false });
    console.log('✅ Synchronisation complétée\n');

    // Vérifier que LeavePolicy existe
    const tableDescription = await sequelize.getQueryInterface().describeTable('leave_policy').catch(() => null);
    
    if (tableDescription) {
      console.log('✅ Table leave_policy créée avec succès');
      console.log('\nColonnes présentes:');
      Object.keys(tableDescription).forEach(col => {
        console.log(`  - ${col}: ${tableDescription[col].type}`);
      });
    } else {
      console.log('⚠️ Table leave_policy n\'existe pas (peut être attendu si en création)');
    }

    // Compter les entreprises
    const empresCount = await Entreprise.count();
    console.log(`\n📊 ${empresCount} entreprise(s) dans la BD`);

    // Vérifier les policies
    const policyCount = await LeavePolicy.count();
    console.log(`📋 ${policyCount} politique(s) de congés configurée(s)`);

    console.log('\n✅ Synchronisation terminée avec succès\n');
    process.exit(0);
  } catch (err) {
    console.error('❌ Erreur lors de la synchronisation:', err.message);
    process.exit(1);
  }
};

syncDatabase();
