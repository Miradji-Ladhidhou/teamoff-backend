const { Model } = require('sequelize');

class EmailLog extends Model {}

module.exports = (sequelize, DataTypes) => {
  EmailLog.init(
    {
      id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
      type:          { type: DataTypes.STRING(100), allowNull: true },   // templateName
      from_address:  { type: DataTypes.STRING(255), allowNull: true },
      to_address:    { type: DataTypes.STRING(255), allowNull: false },
      subject:       { type: DataTypes.STRING(500), allowNull: true },
      statut:        { type: DataTypes.ENUM('success', 'failed', 'simulated'), allowNull: false, defaultValue: 'success' },
      provider:      { type: DataTypes.STRING(50),  allowNull: true },   // 'gmail' | 'resend' | 'smtp' | 'simulate'
      message_id:    { type: DataTypes.STRING(255), allowNull: true },   // ID externe du provider
      error_message: { type: DataTypes.TEXT,        allowNull: true },   // si statut='failed'
      entreprise_id: { type: DataTypes.UUID, allowNull: true, references: { model: 'entreprise', key: 'id' }, onDelete: 'SET NULL' },
      utilisateur_id:{ type: DataTypes.UUID, allowNull: true, references: { model: 'utilisateur', key: 'id' }, onDelete: 'SET NULL' },
    },
    {
      sequelize,
      modelName: 'EmailLog',
      tableName: 'email_logs',
      underscored: true,
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: false,
      indexes: [
        { fields: ['to_address'] },
        { fields: ['statut'] },
        { fields: ['type'] },
        { fields: ['entreprise_id'] },
        { fields: ['created_at'] },
      ],
    },
  );
  return EmailLog;
};
