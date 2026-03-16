const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  return sequelize.define('JoursFeries', {
    id: {
      type: DataTypes.UUID,
      primaryKey: true,
      defaultValue: DataTypes.UUIDV4,
    },
    entreprise_id: { type: DataTypes.UUID, allowNull: false },
    date: { type: DataTypes.DATEONLY, allowNull: false },
    libelle: { type: DataTypes.STRING(255), allowNull: false },
    recurrent: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    est_travail: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  }, {
    tableName: 'jours_feries',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    indexes: [
      {
        unique: true,
        fields: ['entreprise_id', 'date']
      }
    ]
  });
};
