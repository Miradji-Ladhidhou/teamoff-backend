'use strict';

// Charger .env.test si disponible, sinon .env
const path = require('path');
const envFile = path.resolve(__dirname, '..', '.env.test');
const fallback = path.resolve(__dirname, '..', '.env');
try { require('dotenv').config({ path: envFile }); } catch { require('dotenv').config({ path: fallback }); }

// En test, utiliser DATABASE_TEST_URL si défini
if (process.env.NODE_ENV === 'test' && process.env.DATABASE_TEST_URL) {
  process.env.DATABASE_URL = process.env.DATABASE_TEST_URL;
}

module.exports = {
  development: {
    use_env_variable: 'DATABASE_URL',
    dialect: 'postgres',
  },
  test: {
    use_env_variable: 'DATABASE_URL',
    dialect: 'postgres',
  },
  production: {
    use_env_variable: 'DATABASE_URL',
    dialect: 'postgres',
    dialectOptions: {
      ssl: { require: true, rejectUnauthorized: false },
    },
  },
};
