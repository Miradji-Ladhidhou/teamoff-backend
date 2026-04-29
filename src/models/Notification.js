module.exports = (sequelize, DataTypes) => {
  return sequelize.define('Notification', {
    id: {
      type: DataTypes.UUID,
      primaryKey: true,
      defaultValue: DataTypes.UUIDV4,
    },
    entreprise_id: {
      type: DataTypes.UUID,
      allowNull: false,
      references: { model: 'entreprise', key: 'id' },
      onDelete: 'CASCADE',
    },
    utilisateur_id: {
      type: DataTypes.UUID,
      allowNull: false,
      references: { model: 'utilisateur', key: 'id' },
      onDelete: 'CASCADE',
    },
    type: {
      type: DataTypes.STRING(50),
      allowNull: true,
    },
    message: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    url: {
      type: DataTypes.STRING(500),
      allowNull: true,
    },
    lu: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
  }, {
    tableName: 'notification',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: false,
    indexes: [
      { fields: ['utilisateur_id'] },
      { fields: ['utilisateur_id', 'lu'] },
      { fields: ['entreprise_id'] },
    ],
  });
};
