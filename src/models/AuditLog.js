const { Model } = require('sequelize');

class AuditLog extends Model {}

module.exports = (sequelize, DataTypes) => {
  AuditLog.init(
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true
      },

      action: {
        type: DataTypes.STRING,
        allowNull: false
      },

      entity: {
        type: DataTypes.STRING
      },

      entity_id: {
        type: DataTypes.UUID
      },

      user_id: {
        type: DataTypes.UUID,
        allowNull: true,
        references: {
          model: 'utilisateur',
          key: 'id'
        },
        onDelete: 'SET NULL'
      },

      entreprise_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: {
          model: 'entreprise',
          key: 'id'
        },
        onDelete: 'CASCADE'
      },

      ip_address: DataTypes.STRING,

      user_agent: DataTypes.STRING,

      metadata: DataTypes.JSON
    },
    {
      sequelize,
      modelName: 'AuditLog',
      tableName: 'audit_logs',
      timestamps: true
    }
  );

  return AuditLog;
};