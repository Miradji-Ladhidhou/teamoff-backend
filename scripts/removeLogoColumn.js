require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const { sequelize } = require('../src/models');

const run = async () => {
  try {
    await sequelize.authenticate();
    console.log('Connexion DB OK');

    await sequelize.query(`
      ALTER TABLE entreprise
      DROP COLUMN IF EXISTS logo;
    `);

    console.log('Colonne "logo" supprimee (si existante)');
    process.exit(0);
  } catch (error) {
    console.error('Erreur suppression colonne logo :', error);
    process.exit(1);
  }
};

run();
