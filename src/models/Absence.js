module.exports = (sequelize, DataTypes) => {
  const Absence = sequelize.define('Absence', {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    utilisateur_id: {
      type: DataTypes.UUID,
      allowNull: false,
      references: { model: 'Utilisateurs', key: 'id' },
    },
    entreprise_id: {
      type: DataTypes.UUID,
      allowNull: false,
      references: { model: 'Entreprises', key: 'id' },
    },
    type_absence: {
      type: DataTypes.STRING,
      allowNull: false,
      validate: {
        isIn: [['maladie', 'absence_exceptionnelle']],
      },
    },
    date_debut: {
      type: DataTypes.DATEONLY,
      allowNull: false,
    },
    date_fin: {
      type: DataTypes.DATEONLY,
      allowNull: false,
      validate: {
        isAfterOrEqual(value) {
          if (this.date_debut && value < this.date_debut) {
            throw new Error('La date de fin doit être postérieure ou égale à la date de début');
          }
        },
      },
    },
    justificatif: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    commentaire: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    statut: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: 'signalée',
      validate: {
        isIn: [['signalée']],
      }
    }
  }, {
    tableName: 'Absences',
    underscored: true,
    timestamps: true,
  });

  Absence.associate = (models) => {
    Absence.belongsTo(models.Utilisateur, { foreignKey: 'utilisateur_id', as: 'utilisateur' });
    Absence.belongsTo(models.Entreprise, { foreignKey: 'entreprise_id', as: 'entreprise' });
  };

  return Absence;
};