'use strict';
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('mouvement_solde', {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.literal('gen_random_uuid()'),
        primaryKey: true,
        allowNull: false,
      },
      entreprise_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'entreprise', key: 'id' },
        onDelete: 'CASCADE',
      },
      utilisateur_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'utilisateur', key: 'id' },
        onDelete: 'CASCADE',
      },
      conge_type_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'conge_type', key: 'id' },
        onDelete: 'CASCADE',
      },
      annee: {
        type: Sequelize.INTEGER,
        allowNull: false,
      },
      date: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('NOW()'),
      },
      type: {
        type: Sequelize.STRING(50),
        allowNull: false,
        // credit_initial | credit_mensuel | report_annee
        // reservation | validation_auto | validation
        // rejet | annulation | activation_reservation
        // ajustement_admin
      },
      quantite: {
        type: Sequelize.DECIMAL(6, 2),
        allowNull: false,
      },
      solde_apres: {
        type: Sequelize.DECIMAL(6, 2),
        allowNull: false,
      },
      source_id: {
        type: Sequelize.UUID,
        allowNull: true,
      },
      description: {
        type: Sequelize.STRING(255),
        allowNull: true,
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('NOW()'),
      },
      updated_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('NOW()'),
      },
    });

    await queryInterface.addIndex('mouvement_solde', ['utilisateur_id', 'conge_type_id', 'annee'], { name: 'ms_user_type_year' });
    await queryInterface.addIndex('mouvement_solde', ['entreprise_id', 'annee'], { name: 'ms_entreprise_year' });
    await queryInterface.addIndex('mouvement_solde', ['source_id'], { name: 'ms_source_id' });
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('mouvement_solde');
  },
};
