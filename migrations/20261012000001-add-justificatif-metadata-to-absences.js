'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const tableDesc = await queryInterface.describeTable('Absences');
    if (!tableDesc.justificatif_metadata) {
      await queryInterface.addColumn('Absences', 'justificatif_metadata', {
        type: Sequelize.JSON,
        allowNull: true,
        defaultValue: null,
      });
    }
  },

  async down(queryInterface) {
    const tableDesc = await queryInterface.describeTable('Absences');
    if (tableDesc.justificatif_metadata) {
      await queryInterface.removeColumn('Absences', 'justificatif_metadata');
    }
  },
};
