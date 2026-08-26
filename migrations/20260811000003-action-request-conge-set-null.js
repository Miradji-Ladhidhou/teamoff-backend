'use strict';

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TABLE conge_action_request
        DROP CONSTRAINT IF EXISTS conge_action_request_conge_id_fkey;

      ALTER TABLE conge_action_request
        ALTER COLUMN conge_id DROP NOT NULL;

      ALTER TABLE conge_action_request
        ADD CONSTRAINT conge_action_request_conge_id_fkey
        FOREIGN KEY (conge_id) REFERENCES conge(id) ON DELETE SET NULL;
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TABLE conge_action_request
        DROP CONSTRAINT IF EXISTS conge_action_request_conge_id_fkey;

      DELETE FROM conge_action_request WHERE conge_id IS NULL;

      ALTER TABLE conge_action_request
        ALTER COLUMN conge_id SET NOT NULL;

      ALTER TABLE conge_action_request
        ADD CONSTRAINT conge_action_request_conge_id_fkey
        FOREIGN KEY (conge_id) REFERENCES conge(id) ON DELETE CASCADE;
    `);
  },
};
