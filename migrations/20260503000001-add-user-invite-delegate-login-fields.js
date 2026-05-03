'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const tableDescription = await queryInterface.describeTable('utilisateur');

    if (!tableDescription.last_login) {
      await queryInterface.addColumn('utilisateur', 'last_login', {
        type: Sequelize.DATE,
        allowNull: true,
        defaultValue: null,
      });
    }

    if (!tableDescription.invite_token_hash) {
      await queryInterface.addColumn('utilisateur', 'invite_token_hash', {
        type: Sequelize.STRING(64),
        allowNull: true,
        defaultValue: null,
      });
    }

    if (!tableDescription.delegue_id) {
      await queryInterface.addColumn('utilisateur', 'delegue_id', {
        type: Sequelize.UUID,
        allowNull: true,
        defaultValue: null,
      });
    }
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('utilisateur', 'delegue_id');
    await queryInterface.removeColumn('utilisateur', 'invite_token_hash');
    await queryInterface.removeColumn('utilisateur', 'last_login');
  },
};
