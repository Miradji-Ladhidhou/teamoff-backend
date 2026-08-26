'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('conge_action_request', {
      id: {
        type: Sequelize.UUID,
        primaryKey: true,
        defaultValue: Sequelize.UUIDV4,
        allowNull: false,
      },
      conge_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'conge', key: 'id' },
        onDelete: 'CASCADE',
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
      type: {
        type: Sequelize.ENUM('cancel', 'modify'),
        allowNull: false,
      },
      statut: {
        type: Sequelize.ENUM('pending', 'approved', 'rejected'),
        allowNull: false,
        defaultValue: 'pending',
      },
      date_debut_demandee: { type: Sequelize.DATEONLY, allowNull: true },
      date_fin_demandee:   { type: Sequelize.DATEONLY, allowNull: true },
      debut_demi_journee_demandee: {
        type: Sequelize.ENUM('matin', 'apres_midi'),
        allowNull: true,
      },
      fin_demi_journee_demandee: {
        type: Sequelize.ENUM('matin', 'apres_midi'),
        allowNull: true,
      },
      commentaire_employe: { type: Sequelize.TEXT, allowNull: false },
      commentaire_admin:   { type: Sequelize.TEXT, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    });

    await queryInterface.addIndex('conge_action_request', ['conge_id']);
    await queryInterface.addIndex('conge_action_request', ['entreprise_id', 'statut']);
  },

  async down(queryInterface) {
    await queryInterface.dropTable('conge_action_request');
  },
};
