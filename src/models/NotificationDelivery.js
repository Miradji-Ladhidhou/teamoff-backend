'use strict';

module.exports = (sequelize, DataTypes) => sequelize.define('NotificationDelivery', {
  id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
  key: { type: DataTypes.STRING(64), allowNull: false, unique: true },
  entreprise_id: { type: DataTypes.UUID, allowNull: false },
  utilisateur_id: { type: DataTypes.UUID, allowNull: false },
  event: { type: DataTypes.STRING(100), allowNull: false },
  status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'sending' },
}, {
  tableName: 'notification_delivery', timestamps: true,
  createdAt: 'created_at', updatedAt: 'updated_at',
});
