'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('utilisateur', 'refresh_token_hash', {
      type: Sequelize.STRING(64), // SHA-256 hex = 64 chars
      allowNull: true,
      defaultValue: null,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('utilisateur', 'refresh_token_hash');
  },
};
