'use strict';
/**
 * global-teardown.js — exécuté UNE seule fois après tous les tests.
 * Ferme toutes les connexions Sequelize ouvertes.
 */

module.exports = async () => {
  try {
    const { sequelize } = require('../src/models');
    await sequelize.close();
  } catch {
    // Connexion peut déjà être fermée
  }
};
