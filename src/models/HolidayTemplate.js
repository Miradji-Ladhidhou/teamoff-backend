module.exports = (sequelize, DataTypes) => {
  return sequelize.define('HolidayTemplate', {
    id: {
      type: DataTypes.UUID,
      primaryKey: true,
      defaultValue: DataTypes.UUIDV4,
    },
    name: {
      type: DataTypes.STRING(150),
      allowNull: false,
    },
    region: {
      type: DataTypes.STRING(120),
      allowNull: true,
    },
    country_code: {
      type: DataTypes.STRING(2),
      allowNull: false,
      defaultValue: 'FR',
    },
    created_by: {
      type: DataTypes.UUID,
      allowNull: true,
      references: { model: 'utilisateur', key: 'id' },
      onDelete: 'SET NULL',
    },
    source_entreprise_id: {
      type: DataTypes.UUID,
      allowNull: true,
      references: { model: 'entreprise', key: 'id' },
      onDelete: 'CASCADE',
    },
  }, {
    tableName: 'holiday_templates',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    indexes: [
      { fields: ['source_entreprise_id'] },
      { fields: ['created_by'] },
      { fields: ['country_code'] },
    ],
  });
};
