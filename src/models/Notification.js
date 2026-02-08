const { DataTypes } = require('sequelize');

module.exports = (sequelize) =>
  sequelize.define(
    'Notification',
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
      entreprise_id: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      type: {
        type: DataTypes.STRING(50),
      },
      message: {
        type: DataTypes.TEXT,
        allowNull: false,
      },
      url: {
        type: DataTypes.STRING(255),
      },
      lu: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
    },
    {
      tableName: 'notification',
      timestamps: false,
      createdAt: 'created_at',
      updatedAt: false,
    }
  );
