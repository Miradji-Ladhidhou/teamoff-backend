"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    const tableDesc = await queryInterface.describeTable('system_settings');

    if (!tableDesc.created_at) {
      await queryInterface.addColumn('system_settings', 'created_at', {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('NOW()'),
      });
    }
    if (!tableDesc.updated_at) {
      await queryInterface.addColumn('system_settings', 'updated_at', {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('NOW()'),
      });
    }
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('system_settings', 'created_at').catch(() => {});
    await queryInterface.removeColumn('system_settings', 'updated_at').catch(() => {});
  },
};
