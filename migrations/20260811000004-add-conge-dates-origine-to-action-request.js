'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('conge_action_request', 'conge_date_debut_origine', {
      type: Sequelize.DATEONLY,
      allowNull: true,
    });
    await queryInterface.addColumn('conge_action_request', 'conge_date_fin_origine', {
      type: Sequelize.DATEONLY,
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('conge_action_request', 'conge_date_debut_origine');
    await queryInterface.removeColumn('conge_action_request', 'conge_date_fin_origine');
  },
};
