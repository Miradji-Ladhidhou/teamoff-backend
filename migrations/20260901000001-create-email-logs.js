'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('email_logs', {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.literal('gen_random_uuid()'),
        primaryKey: true,
        allowNull: false,
      },
      type: {
        type: Sequelize.STRING(100),
        allowNull: true,
      },
      from_address: {
        type: Sequelize.STRING(255),
        allowNull: true,
      },
      to_address: {
        type: Sequelize.STRING(255),
        allowNull: false,
      },
      subject: {
        type: Sequelize.STRING(500),
        allowNull: true,
      },
      statut: {
        type: Sequelize.ENUM('success', 'failed', 'simulated'),
        allowNull: false,
        defaultValue: 'success',
      },
      provider: {
        type: Sequelize.STRING(50),
        allowNull: true,
      },
      message_id: {
        type: Sequelize.STRING(255),
        allowNull: true,
      },
      error_message: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      entreprise_id: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: 'entreprise', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      utilisateur_id: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: 'utilisateur', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('NOW()'),
      },
    });

    await queryInterface.addIndex('email_logs', ['to_address']);
    await queryInterface.addIndex('email_logs', ['statut']);
    await queryInterface.addIndex('email_logs', ['type']);
    await queryInterface.addIndex('email_logs', ['entreprise_id']);
    await queryInterface.addIndex('email_logs', ['created_at']);
  },

  async down(queryInterface) {
    await queryInterface.dropTable('email_logs');
  },
};
