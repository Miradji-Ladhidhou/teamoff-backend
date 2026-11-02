'use strict';

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

function check(environment, env = process.env) {
  if (!['development', 'production'].includes(environment)) throw new Error('Environnement de déploiement non autorisé.');
  const filename = path.resolve(__dirname, '..', '.env');
  const local = fs.existsSync(filename) ? dotenv.parse(fs.readFileSync(filename)) : {};
  if (local.NODE_ENV && local.NODE_ENV !== environment) throw new Error('Le fichier applicatif .env contredit le déploiement.');
  if (env.NODE_ENV && env.NODE_ENV !== environment) throw new Error('NODE_ENV contredit le déploiement.');
  if (env.DATABASE_URL && local.DATABASE_URL && env.DATABASE_URL !== local.DATABASE_URL) {
    throw new Error('Sources de configuration applicative contradictoires.');
  }
  if (!env.DATABASE_URL && !local.DATABASE_URL) throw new Error('Configuration applicative absente.');
  console.log(`Configuration de déploiement ${environment} vérifiée sans connexion DB. Aucune copie de fichier ni migration.`);
}

if (require.main === module) {
  try {
    if (process.argv.length !== 3) throw new Error('Un environnement explicite est requis.');
    check(process.argv[2]);
  } catch (error) {
    console.error(`[deployment-safety] ${error.message}`);
    process.exitCode = 1;
  }
}
module.exports = { check };
