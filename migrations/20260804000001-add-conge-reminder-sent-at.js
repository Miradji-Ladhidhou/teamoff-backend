'use strict';
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('conge', 'reminder_j30_sent_at', {
      type: Sequelize.DATE,
      allowNull: true,
      defaultValue: null,
    });
    await queryInterface.addColumn('conge', 'reminder_j7_sent_at', {
      type: Sequelize.DATE,
      allowNull: true,
      defaultValue: null,
    });
  },
  down: async (queryInterface) => {
    await queryInterface.removeColumn('conge', 'reminder_j30_sent_at');
    await queryInterface.removeColumn('conge', 'reminder_j7_sent_at');
  },
};
