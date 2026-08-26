'use strict';
/**
 * Remplace onDelete: CASCADE sur audit_logs.entreprise_id par SET NULL.
 *
 * Motivation : la suppression d'une entreprise effaçait toute sa trace d'audit,
 * rendant impossible tout audit post-mortem. Avec SET NULL, les logs sont préservés,
 * entreprise_id devient null, mais entity_id / action / metadata restent intacts.
 */

module.exports = {
  async up(queryInterface, Sequelize) {
    // 1. Supprimer la contrainte CASCADE existante
    await queryInterface.sequelize.query(`
      ALTER TABLE audit_logs
        DROP CONSTRAINT IF EXISTS "audit_logs_entreprise_id_fkey";
    `);

    // 2. Rendre la colonne nullable (nécessaire pour SET NULL)
    await queryInterface.sequelize.query(`
      ALTER TABLE audit_logs
        ALTER COLUMN entreprise_id DROP NOT NULL;
    `);

    // 3. Recréer la contrainte avec SET NULL
    await queryInterface.sequelize.query(`
      ALTER TABLE audit_logs
        ADD CONSTRAINT "audit_logs_entreprise_id_fkey"
        FOREIGN KEY (entreprise_id)
        REFERENCES entreprise(id)
        ON DELETE SET NULL;
    `);
  },

  async down(queryInterface, Sequelize) {
    // Rollback : remettre CASCADE + NOT NULL
    // Attention : échouera si des logs ont entreprise_id = NULL
    await queryInterface.sequelize.query(`
      ALTER TABLE audit_logs
        DROP CONSTRAINT IF EXISTS "audit_logs_entreprise_id_fkey";
    `);
    await queryInterface.sequelize.query(`
      ALTER TABLE audit_logs
        ALTER COLUMN entreprise_id SET NOT NULL;
    `);
    await queryInterface.sequelize.query(`
      ALTER TABLE audit_logs
        ADD CONSTRAINT "audit_logs_entreprise_id_fkey"
        FOREIGN KEY (entreprise_id)
        REFERENCES entreprise(id)
        ON DELETE CASCADE;
    `);
  },
};
