const { DataTypes } = require('sequelize');

module.exports = (sequelize) =>
  sequelize.define(
    'AuditLog',
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
      utilisateur_id: {
        type: DataTypes.UUID,
      },
      action: {
        type: DataTypes.STRING,
        allowNull: false,
      },
      meta: {
        type: DataTypes.JSONB,
        allowNull: false,
        defaultValue: {},
      },
    },
    {
      tableName: 'audit_log',
      timestamps: true,
      createAt: 'created_at',
      updatedAt: false,
      indexes: [
        {
          fields: ['entreprise_id'],
        },
        {
          fields: ['utilisateur_id'],
        },
      ],
    }
  );
