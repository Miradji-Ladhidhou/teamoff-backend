'use strict';
/**
 * setup.js — exécuté avant CHAQUE fichier de test (setupFilesAfterEnv).
 *
 * - Garantit que la connexion DB est active
 * - Expose un helper global `truncateTables()` pour nettoyer entre suites
 */

// sanitize-html v2.13+ dépend de htmlparser2 v12 (ESM-only), incompatible avec
// le runner Jest CommonJS. En test, on n'a pas besoin de l'assainissement HTML :
// on mocke par un pass-through transparent.
jest.mock('sanitize-html', () => (html) => html);

const { sequelize } = require('../src/models');

// Connexion DB disponible pour tous les tests du fichier
beforeAll(async () => {
  await sequelize.authenticate();
});

// Fermeture gérée par global-teardown — pas ici, sinon conflit entre fichiers

/**
 * Tronque les tables dans l'ordre inverse des FK pour éviter les violations.
 * Réservé aux suites qui créent des données persistantes.
 */
global.truncateTables = async (tables) => {
  const names = tables || [
    'conge',
    'compteur_conges',
    'conge_type',
    'notification',
    '"Absences"',
    'leave_policy',
    'audit_logs',
    'jours_feries',
    'utilisateur',
    'entreprise',
  ];

  for (const t of names) {
    await sequelize.query(`TRUNCATE TABLE ${t} CASCADE`);
  }
};
