'use strict';
/**
 * setup.js — exécuté avant CHAQUE fichier de test (setupFilesAfterEnv).
 *
 * - Garantit que la connexion DB est active
 * - Expose un helper global `truncateTables()` pour nettoyer entre suites
 */

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
