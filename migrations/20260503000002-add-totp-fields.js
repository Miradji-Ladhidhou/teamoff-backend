'use strict';
module.exports = {
  async up(queryInterface, Sequelize) {
    const desc = await queryInterface.describeTable('utilisateur');
    if (!desc.totp_secret) {
      await queryInterface.addColumn('utilisateur', 'totp_secret', {
        type: Sequelize.TEXT, allowNull: true, defaultValue: null,
      });
    }
    if (!desc.totp_enabled) {
      await queryInterface.addColumn('utilisateur', 'totp_enabled', {
        type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false,
      });
    }
  },
  async down(queryInterface) {
    await queryInterface.removeColumn('utilisateur', 'totp_enabled');
    await queryInterface.removeColumn('utilisateur', 'totp_secret');
  },
};
