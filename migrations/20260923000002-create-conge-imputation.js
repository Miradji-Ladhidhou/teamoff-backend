'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('conge_imputation', {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.literal('gen_random_uuid()'),
        primaryKey: true,
        allowNull: false,
      },
      conge_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'conge', key: 'id' },
        onDelete: 'CASCADE',
      },
      compteur_conges_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'compteur_conges', key: 'id' },
        onDelete: 'RESTRICT',
      },
      annee: {
        type: Sequelize.INTEGER,
        allowNull: false,
      },
      jours: {
        type: Sequelize.DECIMAL(6, 2),
        allowNull: false,
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('NOW()'),
      },
      updated_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('NOW()'),
      },
    });

    await queryInterface.addIndex('conge_imputation', ['conge_id'], { name: 'conge_imputation_conge_idx' });
    await queryInterface.addIndex('conge_imputation', ['compteur_conges_id'], { name: 'conge_imputation_compteur_idx' });
    await queryInterface.addIndex('conge_imputation', ['conge_id', 'annee'], {
      name: 'conge_imputation_conge_year_unique',
      unique: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('conge_imputation');
  },
};
