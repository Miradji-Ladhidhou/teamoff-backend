'use strict';

module.exports = {
  async up(queryInterface) {
    // Trouver et supprimer toute contrainte unique sur (entreprise_id, email)
    // sans dépendre du nom exact (qui varie entre dev et prod)
    await queryInterface.sequelize.query(`
      DO $$
      DECLARE
        r RECORD;
      BEGIN
        FOR r IN
          SELECT c.conname
          FROM pg_constraint c
          JOIN pg_class t ON t.oid = c.conrelid
          WHERE t.relname = 'utilisateur'
            AND c.contype = 'u'
            AND (
              SELECT array_agg(a.attname ORDER BY a.attname)
              FROM pg_attribute a
              WHERE a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
            ) = ARRAY['email','entreprise_id']
        LOOP
          EXECUTE 'ALTER TABLE utilisateur DROP CONSTRAINT ' || quote_ident(r.conname);
        END LOOP;
      END
      $$;
    `);

    // Supprimer aussi d'éventuels index uniques résiduels sur (entreprise_id, email)
    await queryInterface.sequelize.query(`
      DO $$
      DECLARE
        r RECORD;
      BEGIN
        FOR r IN
          SELECT i.relname
          FROM pg_index x
          JOIN pg_class t ON t.oid = x.indrelid
          JOIN pg_class i ON i.oid = x.indexrelid
          WHERE t.relname = 'utilisateur'
            AND x.indisunique = true
            AND (
              SELECT array_agg(a.attname ORDER BY a.attname)
              FROM pg_attribute a
              WHERE a.attrelid = x.indrelid AND a.attnum = ANY(x.indkey)
            ) = ARRAY['email','entreprise_id']
        LOOP
          EXECUTE 'DROP INDEX IF EXISTS ' || quote_ident(r.relname);
        END LOOP;
      END
      $$;
    `);

    // Ajouter la contrainte unique globale sur email seul
    await queryInterface.addConstraint('utilisateur', {
      fields: ['email'],
      type: 'unique',
      name: 'utilisateur_email_unique',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeConstraint('utilisateur', 'utilisateur_email_unique');
    await queryInterface.addConstraint('utilisateur', {
      fields: ['entreprise_id', 'email'],
      type: 'unique',
      name: 'entreprise_email_unique',
    });
  },
};
