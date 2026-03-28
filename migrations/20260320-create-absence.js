"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable("Absences", {
      id: {
        allowNull: false,
        primaryKey: true,
        type: Sequelize.UUID,
        defaultValue: Sequelize.literal('uuid_generate_v4()')
      },
      utilisateur_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: "utilisateur", key: "id" },
        onDelete: "CASCADE"
      },
      entreprise_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: "entreprise", key: "id" },
        onDelete: "CASCADE"
      },
      type: {
        type: Sequelize.STRING,
        allowNull: false
      },
      date_debut: {
        type: Sequelize.DATEONLY,
        allowNull: false
      },
      date_fin: {
        type: Sequelize.DATEONLY,
        allowNull: false
      },
      commentaire: {
        type: Sequelize.TEXT,
        allowNull: true
      },
      statut: {
        type: Sequelize.STRING,
        allowNull: false,
        defaultValue: "en_attente"
      },
      created_at: {
        allowNull: false,
        type: Sequelize.DATE,
        defaultValue: Sequelize.literal('NOW()')
      },
      updated_at: {
        allowNull: false,
        type: Sequelize.DATE,
        defaultValue: Sequelize.literal('NOW()')
      }
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable("Absences");
  }
};
