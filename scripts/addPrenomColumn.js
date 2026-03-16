// scripts/addPrenomColumn.js

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const { sequelize } = require('../src/models');

const run = async () => {
  try {
    await sequelize.authenticate();
    console.log('✅ Connexion DB OK');

    // Migration : ajouter la colonne prenom si elle n'existe pas
    await sequelize.query(`
      ALTER TABLE utilisateur
      ADD COLUMN IF NOT EXISTS prenom VARCHAR(255);
    `);

    console.log('✅ Colonne "prenom" ajoutée (si nécessaire)');
    process.exit(0);
  } catch (error) {
    console.error('❌ Erreur migration prenom :', error);
    process.exit(1);
  }
};

run();
