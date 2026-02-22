const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  return sequelize.define('CompteurConges', {
    id: {
      type: DataTypes.UUID,
      primaryKey: true,
      defaultValue: DataTypes.UUIDV4,
    },
    entreprise_id: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    utilisateur_id: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    conge_type_id: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    annee: {
      type: DataTypes.INTEGER,
      allowNull: false,
      validate: { min: 2000 },
    },
    jours_acquis: {
      type: DataTypes.NUMERIC(5,2),
      allowNull: false,
      defaultValue: 0,
    },
    jours_pris: {
      type: DataTypes.NUMERIC(5,2),
      allowNull: false,
      defaultValue: 0,
    },
  }, {
    tableName: 'compteur_conges',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    indexes: [
      { fields: ['entreprise_id', 'utilisateur_id', 'annee'] },
      { fields: ['entreprise_id', 'annee'] },
      { fields: ['entreprise_id', 'conge_type_id'] },
    ],
    uniqueKeys: {
      compteur_unique: {
        fields: ['entreprise_id','utilisateur_id','conge_type_id','annee'],
      },
    },
  });
};
