"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    const tableDesc = await queryInterface.describeTable('notification');

    // Agrandir url STRING(255) → STRING(500) si nécessaire
    if (tableDesc.url) {
      await queryInterface.changeColumn('notification', 'url', {
        type: Sequelize.STRING(500),
        allowNull: true,
      });
    }

    const indexes = await queryInterface.showIndex('notification');
    const existing = indexes.map(i => JSON.stringify(i.fields));

    if (!existing.includes(JSON.stringify(['utilisateur_id']))) {
      await queryInterface.addIndex('notification', ['utilisateur_id']);
    }
    if (!existing.includes(JSON.stringify(['utilisateur_id', 'lu']))) {
      await queryInterface.addIndex('notification', ['utilisateur_id', 'lu']);
    }
    if (!existing.includes(JSON.stringify(['entreprise_id']))) {
      await queryInterface.addIndex('notification', ['entreprise_id']);
    }
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('notification', ['utilisateur_id']).catch(() => {});
    await queryInterface.removeIndex('notification', ['utilisateur_id', 'lu']).catch(() => {});
    await queryInterface.removeIndex('notification', ['entreprise_id']).catch(() => {});
  },
};
