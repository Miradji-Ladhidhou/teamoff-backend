'use strict';

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(
      `ALTER TYPE "enum_utilisateurs_role" ADD VALUE IF NOT EXISTS 'apprenti'`
    );
  },
  async down() {
    // PostgreSQL ne permet pas de supprimer une valeur d'un ENUM
  },
};
