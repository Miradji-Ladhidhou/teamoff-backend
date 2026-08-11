'use strict';

/** Ajoute la valeur 'reserve' à l'enum enum_conge_statut si elle n'existe pas. */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_enum
          WHERE enumlabel = 'reserve'
            AND enumtypid = 'enum_conge_statut'::regtype
        ) THEN
          ALTER TYPE enum_conge_statut ADD VALUE 'reserve';
        END IF;
      END;
      $$;
    `);
  },

  async down() {
    // PostgreSQL ne permet pas de supprimer une valeur d'enum sans recréer le type
  },
};
