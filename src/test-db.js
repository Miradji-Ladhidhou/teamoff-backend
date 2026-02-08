const sequelize = require('./config/database');

async function testConnection() {
  try {
    await sequelize.authenticate();
    console.log('✅ Connexion à la base de données réussie !');
  } catch (error) {
    console.error('❌ Impossible de se connecter :', error);
  }
}

testConnection();
