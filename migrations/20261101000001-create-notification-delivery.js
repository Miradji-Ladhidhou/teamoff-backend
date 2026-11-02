'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('notification_delivery', {
      id: { type: Sequelize.UUID, primaryKey: true, allowNull: false },
      key: { type: Sequelize.STRING(64), unique: true, allowNull: false },
      entreprise_id: {
        type: Sequelize.UUID, allowNull: false,
        references: { model: 'entreprise', key: 'id' }, onDelete: 'CASCADE',
      },
      utilisateur_id: {
        type: Sequelize.UUID, allowNull: false,
        references: { model: 'utilisateur', key: 'id' }, onDelete: 'CASCADE',
      },
      event: { type: Sequelize.STRING(100), allowNull: false },
      status: { type: Sequelize.STRING(20), allowNull: false, defaultValue: 'sending' },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
  },
  async down(queryInterface) {
    await queryInterface.dropTable('notification_delivery');
  },
};
