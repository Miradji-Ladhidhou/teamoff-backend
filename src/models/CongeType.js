const { DataTypes } = require('sequelize');

module.exports = (sequelize) =>
  sequelize.define(
    'CongeType',
    {
      id: {
        type: DataTypes.UUID,
        primaryKey: true,
        defaultValue: DataTypes.UUIDV4,
      },
      entreprise_id: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      code: {
        type: DataTypes.STRING(20),
        allowNull: false,
      },
      libelle: {
        type: DataTypes.STRING(255),
        allowNull: false,
      },
      quota_annuel: {
        type: DataTypes.NUMERIC,
        allowNull: true,
      },
      demi_journee_autorisee: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
      },
    },
    {
      tableName: 'conge_type',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      indexes: [
        {
          unique: true,
          fields: ['entreprise_id', 'code'],
        },
      ],
    }
  );
