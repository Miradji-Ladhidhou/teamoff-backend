const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {

  const CompteurConges = sequelize.define('CompteurConges', {

    id: {
      type: DataTypes.UUID,
      primaryKey: true,
      defaultValue: DataTypes.UUIDV4
    },

    entreprise_id: {
      type: DataTypes.UUID,
      allowNull: false
    },

    utilisateur_id: {
      type: DataTypes.UUID,
      allowNull: false
    },

    conge_type_id: {
      type: DataTypes.UUID,
      allowNull: false
    },

    annee: {
      type: DataTypes.INTEGER,
      allowNull: false,
      validate: { min: 2000, max: 2100 }
    },

    jours_acquis: {
      type: DataTypes.DECIMAL(5,2),
      allowNull: false,
      defaultValue: 0
    },

    jours_pris: {
      type: DataTypes.DECIMAL(5,2),
      allowNull: false,
      defaultValue: 0
    },

    jours_reportes: {
      type: DataTypes.DECIMAL(5,2),
      allowNull: false,
      defaultValue: 0
    },

    jours_reserves: {
      type: DataTypes.DECIMAL(5,2),
      allowNull: false,
      defaultValue: 0
    },

    solde_disponible: {
      type: DataTypes.VIRTUAL,
      get() {
        const acquis = parseFloat(this.jours_acquis || 0);
        const reportes = parseFloat(this.jours_reportes || 0);
        const reserves = parseFloat(this.jours_reserves || 0);
        const pris = parseFloat(this.jours_pris || 0);

        return acquis + reportes - reserves - pris;
      }
    }

  }, {

    tableName: 'compteur_conges',

    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',

    indexes: [
      { fields: ['entreprise_id', 'utilisateur_id', 'annee'] },
      { fields: ['utilisateur_id', 'conge_type_id', 'annee'] },
      { fields: ['entreprise_id', 'annee'] },
      { fields: ['entreprise_id', 'conge_type_id'] }
    ],

    uniqueKeys: {
      compteur_unique: {
        fields: ['entreprise_id', 'utilisateur_id', 'conge_type_id', 'annee']
      }
    }

  });

  CompteurConges.prototype.getSoldeDisponible = function () {
    return this.solde_disponible;
  };

  return CompteurConges;
};