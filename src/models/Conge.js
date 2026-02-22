const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  return sequelize.define('Conge', {
    id: {
      type: DataTypes.UUID,
      primaryKey: true,
      defaultValue: DataTypes.UUIDV4,
    },
    entreprise_id: { type: DataTypes.UUID, allowNull: false },
    utilisateur_id: { type: DataTypes.UUID, allowNull: false },
    conge_type_id: { type: DataTypes.UUID, allowNull: false },
    date_debut: { type: DataTypes.DATEONLY, allowNull: false },
    date_fin: { type: DataTypes.DATEONLY, allowNull: false },
    debut_demi_journee: {
      type: DataTypes.ENUM('matin','apres_midi'),
      allowNull: false,
      defaultValue: 'matin',
    },
    fin_demi_journee: {
      type: DataTypes.ENUM('matin','apres_midi'),
      allowNull: false,
      defaultValue: 'apres_midi',
    },
    statut: {
      type: DataTypes.ENUM('en_attente_manager','valide_manager','refuse_manager','valide_final','refuse_final'),
      allowNull: false,
      defaultValue: 'en_attente_manager',
    },
    commentaire_manager: { type: DataTypes.TEXT },
    commentaire_admin: { type: DataTypes.TEXT },
  }, {
    tableName: 'conge',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    indexes: [
      { fields: ['entreprise_id', 'utilisateur_id'] },
      { fields: ['entreprise_id', 'statut'] },
      { fields: ['entreprise_id', 'conge_type_id'] },
    ],
  });
};
