module.exports = (sequelize, DataTypes) => {
  const MouvementSolde = sequelize.define('MouvementSolde', {
    id: {
      type: DataTypes.UUID,
      primaryKey: true,
      defaultValue: DataTypes.UUIDV4,
    },
    entreprise_id: {
      type: DataTypes.UUID,
      allowNull: false,
      references: { model: 'entreprise', key: 'id' },
    },
    utilisateur_id: {
      type: DataTypes.UUID,
      allowNull: false,
      references: { model: 'utilisateur', key: 'id' },
    },
    conge_type_id: {
      type: DataTypes.UUID,
      allowNull: false,
      references: { model: 'conge_type', key: 'id' },
    },
    annee: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    date: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
    type: {
      type: DataTypes.STRING(50),
      allowNull: false,
    },
    quantite: {
      type: DataTypes.DECIMAL(6, 2),
      allowNull: false,
    },
    solde_apres: {
      type: DataTypes.DECIMAL(6, 2),
      allowNull: false,
    },
    source_id: {
      type: DataTypes.UUID,
      allowNull: true,
    },
    description: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
  }, {
    tableName: 'mouvement_solde',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    indexes: [
      { fields: ['utilisateur_id', 'conge_type_id', 'annee'] },
      { fields: ['entreprise_id', 'annee'] },
      { fields: ['source_id'] },
    ],
  });

  return MouvementSolde;
};
