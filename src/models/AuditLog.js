const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  return sequelize.define('AuditLog', {
    id: {
      type: DataTypes.UUID,
      primaryKey: true,
      defaultValue: DataTypes.UUIDV4,
    },
    entreprise_id: { type: DataTypes.UUID, allowNull: false },
    utilisateur_id: { type: DataTypes.UUID, allowNull: true },
    action: { type: DataTypes.STRING(255), allowNull: false },
    meta: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
  }, {
    tableName: 'audit_log',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: false,
  });
};
