const { Model } = require('sequelize');

class AuditLog extends Model {}

module.exports = (sequelize, DataTypes) => {
  AuditLog.init(
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      action: {
        type: DataTypes.STRING,
        allowNull: false,
      },
      entity: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      entity_id: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      user_id: {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'utilisateur', key: 'id' },
        onDelete: 'SET NULL',
      },
      entreprise_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'entreprise', key: 'id' },
        onDelete: 'CASCADE',
      },
      ip_address: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      user_agent: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      metadata: {
        type: DataTypes.JSON,
        allowNull: true,
      },
    },
    {
      sequelize,
      modelName: 'AuditLog',
      tableName: 'audit_logs',
      underscored: true,
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      indexes: [
        { fields: ['entreprise_id'] },
        { fields: ['user_id'] },
        { fields: ['entreprise_id', 'created_at'] },
        { fields: ['entity', 'entity_id'] },
      ],
    },
  );

  return AuditLog;
};
