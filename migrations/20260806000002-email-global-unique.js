'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    // 1. Supprimer la contrainte unique composite (entreprise_id, email)
    await queryInterface.removeConstraint('utilisateur', 'entreprise_email_unique');

    // 2. Ajouter une contrainte unique globale sur email seul
    await queryInterface.addConstraint('utilisateur', {
      fields: ['email'],
      type: 'unique',
      name: 'utilisateur_email_unique',
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeConstraint('utilisateur', 'utilisateur_email_unique');
    await queryInterface.addConstraint('utilisateur', {
      fields: ['entreprise_id', 'email'],
      type: 'unique',
      name: 'entreprise_email_unique',
    });
  },
};
