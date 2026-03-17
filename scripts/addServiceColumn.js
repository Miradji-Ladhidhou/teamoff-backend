// scripts/addServiceColumn.js

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const { sequelize } = require('../src/models');

const run = async () => {
  try {
    await sequelize.authenticate();
    console.log('Connexion DB OK');

    await sequelize.query(`
      ALTER TABLE utilisateur
      ADD COLUMN IF NOT EXISTS service VARCHAR(255);
    `);

    console.log('Colonne "service" ajoutée (si nécessaire)');
    process.exit(0);
  } catch (error) {
    console.error('Erreur migration service :', error);
    process.exit(1);
  }
};

run();