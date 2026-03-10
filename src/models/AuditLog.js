const { Model, DataTypes } = require('sequelize');

class AuditLog extends Model {}

module.exports = (sequelize) => {
  AuditLog.init({
    action: DataTypes.STRING,
    entity: DataTypes.STRING,
    entity_id: DataTypes.INTEGER,
    user_id: DataTypes.INTEGER,
    entreprise_id: DataTypes.INTEGER,
    ip_address: DataTypes.STRING,
    user_agent: DataTypes.STRING,
    metadata: DataTypes.JSON
  }, {
    sequelize,
    modelName: 'AuditLog',
    tableName: 'audit_logs'
  });
  return AuditLog;
};