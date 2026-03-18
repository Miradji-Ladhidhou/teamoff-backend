// scripts/addDateEmbaucheColumn.js

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const { sequelize } = require('../src/models');

const run = async () => {
  try {
    await sequelize.authenticate();
    console.log('Connexion DB OK');

    await sequelize.query(`
      ALTER TABLE utilisateur
      ADD COLUMN IF NOT EXISTS date_embauche DATE;
    `);

    console.log('Colonne "date_embauche" ajoutée (si nécessaire)');
    process.exit(0);
  } catch (error) {
    console.error('Erreur migration date_embauche :', error);
    process.exit(1);
  }
};

run();
