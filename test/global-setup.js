'use strict';
/**
 * global-setup.js — exécuté UNE seule fois avant tous les tests.
 *
 * - Vérifie la connexion à la base de test
 * - Lance les migrations Sequelize-CLI (pas sync)
 * - Nettoie les données de test résiduelles
 */

const { execSync } = require('child_process');
const path = require('path');

module.exports = async () => {
  // Charge .env.test si présent, sinon fallback sur .env
  const envFile = path.resolve(__dirname, '..', '.env.test');
  const fallback = path.resolve(__dirname, '..', '.env');

  try {
    require('dotenv').config({ path: envFile });
  } catch {
    require('dotenv').config({ path: fallback });
  }

  const dbUrl = process.env.DATABASE_TEST_URL || process.env.DATABASE_URL;
  if (!dbUrl) {
    throw new Error(
      'Aucune URL de base de test trouvée.\n' +
      'Définissez DATABASE_TEST_URL dans .env.test ou .env'
    );
  }

  // Forcer l'URL de test pour toute la suite
  process.env.DATABASE_URL = dbUrl;
  process.env.NODE_ENV = 'test';

  console.log('\n[global-setup] Connexion à la base de test...');

  // Lancer les migrations
  try {
    execSync('npx sequelize-cli db:migrate', {
      cwd: path.resolve(__dirname, '..'),
      env: { ...process.env, DATABASE_URL: dbUrl, NODE_ENV: 'test' },
      stdio: 'pipe',
    });
    console.log('[global-setup] Migrations OK');
  } catch (e) {
    const output = e.stdout?.toString() || e.stderr?.toString() || e.message;
    throw new Error(`[global-setup] Migrations échouées :\n${output}`);
  }
};
