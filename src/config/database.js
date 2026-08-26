require('dotenv').config();
const { Sequelize } = require('sequelize');

const isProduction = process.env.NODE_ENV === 'production';

// Timeouts configurables par env — valeurs par défaut conservatives.
// lock_timeout         : durée max d'attente pour acquérir un verrou.
//                        Empêche qu'un client abandonné bloque tous les autres indéfiniment.
// idle_in_transaction  : tue les transactions ouvertes mais inactives (client déconnecté,
//                        exception non catchée). Libère les verrous orphelins.
const LOCK_TIMEOUT_MS             = parseInt(process.env.DB_LOCK_TIMEOUT_MS             || '30000', 10);
const IDLE_IN_TRANSACTION_TIMEOUT_MS = parseInt(process.env.DB_IDLE_IN_TRANSACTION_TIMEOUT_MS || '60000', 10);

const sequelize = new Sequelize(process.env.DATABASE_URL, {
  dialect: 'postgres',
  logging: process.env.NODE_ENV === 'development' ? console.log : false,
  dialectOptions: isProduction
    ? { ssl: { require: true, rejectUnauthorized: false } }
    : {},
  pool: {
    min: 2,
    max: isProduction ? 10 : 5,
    acquire: 30000,
    idle: 10000,
  },
});

// Appliqué à chaque nouvelle connexion du pool.
// Séparés en deux appels pour compatibilité avec les versions de pg
// qui ne supportent pas les statements multiples sur la même query().
sequelize.addHook('afterConnect', async (connection) => {
  await connection.query(`SET lock_timeout = ${LOCK_TIMEOUT_MS}`);
  await connection.query(`SET idle_in_transaction_session_timeout = ${IDLE_IN_TRANSACTION_TIMEOUT_MS}`);
});

module.exports = sequelize;
