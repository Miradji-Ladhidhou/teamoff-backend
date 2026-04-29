module.exports = (sequelize, DataTypes) => {
  return sequelize.define('HolidayTemplateItem', {
    id: {
      type: DataTypes.UUID,
      primaryKey: true,
      defaultValue: DataTypes.UUIDV4,
    },
    template_id: {
      type: DataTypes.UUID,
      allowNull: false,
      references: { model: 'holiday_templates', key: 'id' },
      onDelete: 'CASCADE',
    },
    date: {
      type: DataTypes.DATEONLY,
      allowNull: false,
    },
    libelle: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    recurrent: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    est_travail: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
  }, {
    tableName: 'holiday_template_items',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    indexes: [
      { unique: true, fields: ['template_id', 'date'] },
    ],
  });
};
