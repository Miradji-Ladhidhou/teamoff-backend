'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('conge', 'effective_approval_workflow', {
      type: Sequelize.STRING(30),
      allowNull: true,
      defaultValue: null,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('conge', 'effective_approval_workflow');
  },
};
