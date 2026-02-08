const { DataTypes } = require('sequelize');

module.exports = (sequelize) =>
  sequelize.define(
    'CompteurConges',
    {
      id: {
        type: DataTypes.UUID,
        primaryKey: true,
        defaultValue: DataTypes.UUIDV4,
      },
      utilisateur_id: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      conge_type_id: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      annee: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },
      jours_pris: {
        type: DataTypes.NUMERIC,
        allowNull: false,
        defaultValue: 0,
      },
    },
    {
      tableName: 'compteur_conges',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      indexes: [
        {
          unique: true,
          fields: ['utilisateur_id', 'conge_type_id', 'annee'],
        },
      ],
    }
  );
