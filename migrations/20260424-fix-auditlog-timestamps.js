"use strict";

module.exports = {
  async up(queryInterface) {
    const tableDesc = await queryInterface.describeTable('audit_logs');

    // Renommer createdAt → created_at si nécessaire
    if (tableDesc.createdAt && !tableDesc.created_at) {
      await queryInterface.renameColumn('audit_logs', 'createdAt', 'created_at');
    }
    // Renommer updatedAt → updated_at si nécessaire
    if (tableDesc.updatedAt && !tableDesc.updated_at) {
      await queryInterface.renameColumn('audit_logs', 'updatedAt', 'updated_at');
    }

    // Ajouter updated_at si absent (table créée sans)
    const desc2 = await queryInterface.describeTable('audit_logs');
    if (!desc2.updated_at) {
      await queryInterface.sequelize.query(
        `ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()`
      );
    }

    // Indexes
    const indexes = await queryInterface.showIndex('audit_logs');
    const existing = indexes.map(i => JSON.stringify(i.fields));

    if (!existing.includes(JSON.stringify(['entreprise_id']))) {
      await queryInterface.addIndex('audit_logs', ['entreprise_id']);
    }
    if (!existing.includes(JSON.stringify(['user_id']))) {
      await queryInterface.addIndex('audit_logs', ['user_id']);
    }
    if (!existing.includes(JSON.stringify(['entreprise_id', 'created_at']))) {
      await queryInterface.addIndex('audit_logs', ['entreprise_id', 'created_at']);
    }
    if (!existing.includes(JSON.stringify(['entity', 'entity_id']))) {
      await queryInterface.addIndex('audit_logs', ['entity', 'entity_id']);
    }
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('audit_logs', ['entreprise_id']).catch(() => {});
    await queryInterface.removeIndex('audit_logs', ['user_id']).catch(() => {});
    await queryInterface.removeIndex('audit_logs', ['entreprise_id', 'created_at']).catch(() => {});
    await queryInterface.removeIndex('audit_logs', ['entity', 'entity_id']).catch(() => {});
  },
};
