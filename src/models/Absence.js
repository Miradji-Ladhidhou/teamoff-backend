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
      references: { model: 'utilisateur', key: 'id' },
      onDelete: 'CASCADE',
    },
    entreprise_id: {
      type: DataTypes.UUID,
      allowNull: false,
      references: { model: 'entreprise', key: 'id' },
      onDelete: 'CASCADE',
    },
    type_absence: {
      type: DataTypes.ENUM('maladie', 'absence_exceptionnelle'),
      allowNull: false,
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
      type: DataTypes.STRING(500),
      allowNull: true,
    },
    commentaire: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    statut: {
      type: DataTypes.ENUM('signalée', 'approuvée', 'rejetée'),
      allowNull: false,
      defaultValue: 'signalée',
    },
  }, {
    tableName: 'Absences',
    underscored: true,
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    indexes: [
      { fields: ['utilisateur_id'] },
      { fields: ['entreprise_id'] },
      { fields: ['entreprise_id', 'statut'] },
      { fields: ['date_debut', 'date_fin'] },
    ],
  });

  return Absence;
};
