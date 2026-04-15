'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('leave_policy', {
      id: {
        type: Sequelize.UUID,
        primaryKey: true,
        defaultValue: Sequelize.UUIDV4,
        allowNull: false,
      },

      entreprise_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: {
          model: 'entreprise',
          key: 'id',
        },
        onDelete: 'CASCADE',
        unique: true, // une politique par entreprise
      },

      allow_modify_validated: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false,
        comment: 'Autoriser la modification d\'un congé validé',
      },

      allow_cancel_validated: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false,
        comment: 'Autoriser l\'annulation d\'un congé validé',
      },

      min_notice_days: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 2,
        comment: 'Préavis minimum en jours avant la date de début',
      },

      max_backdate_days: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
        comment: 'Nombre maximum de jours rétroactifs autorisés pour modifier',
      },

      require_manager_approval: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: true,
        comment: 'Validation manager obligatoire pour modification/annulation',
      },

      require_admin_approval: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false,
        comment: 'Validation admin obligatoire pour modification/annulation',
      },

      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.NOW,
      },

      updated_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.NOW,
      },
    });

    // Index pour recherches rapides
    await queryInterface.addIndex('leave_policy', ['entreprise_id']);
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable('leave_policy');
  },
};
