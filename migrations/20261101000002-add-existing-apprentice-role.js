'use strict';

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query('ALTER TYPE "enum_utilisateur_role" ADD VALUE IF NOT EXISTS \'apprenti\'');
  },
  async down() {
    // PostgreSQL cannot remove an ENUM value safely while existing apprentices may reference it.
  },
};
