const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  return sequelize.define('Entreprise', {
    id: {
      type: DataTypes.UUID,
      primaryKey: true,
      defaultValue: DataTypes.UUIDV4,
    },
    nom: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    logo: DataTypes.STRING(255),
    politique_conges: {
      type: DataTypes.JSONB,
      allowNull: false,
      defaultValue: {},
    },
    parametres: {
      type: DataTypes.JSONB,
      allowNull: false,
      defaultValue: {},
    },
    statut: {
      type: DataTypes.ENUM('active', 'inactive', 'suspendue'),
      allowNull: false,
      defaultValue: 'active',
    },
  }, {
    tableName: 'entreprise',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  });
};
