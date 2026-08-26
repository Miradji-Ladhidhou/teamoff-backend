'use strict';
/**
 * Remplace onDelete: CASCADE sur holiday_templates.source_entreprise_id par SET NULL.
 *
 * Motivation : avec CASCADE, supprimer une entreprise détruisait tous les templates
 * de jours fériés qu'elle avait créés, y compris des templates potentiellement utilisés
 * comme référence par d'autres entreprises. Avec SET NULL, les templates survivent
 * avec source_entreprise_id = NULL (template orphelin mais réutilisable).
 */

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TABLE holiday_templates
        DROP CONSTRAINT IF EXISTS "holiday_templates_source_entreprise_id_fkey";
    `);

    await queryInterface.sequelize.query(`
      ALTER TABLE holiday_templates
        ADD CONSTRAINT "holiday_templates_source_entreprise_id_fkey"
        FOREIGN KEY (source_entreprise_id)
        REFERENCES entreprise(id)
        ON DELETE SET NULL;
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TABLE holiday_templates
        DROP CONSTRAINT IF EXISTS "holiday_templates_source_entreprise_id_fkey";
    `);

    await queryInterface.sequelize.query(`
      ALTER TABLE holiday_templates
        ADD CONSTRAINT "holiday_templates_source_entreprise_id_fkey"
        FOREIGN KEY (source_entreprise_id)
        REFERENCES entreprise(id)
        ON DELETE CASCADE;
    `);
  },
};
