'use strict';

module.exports = (sequelize, DataTypes) => {
  return sequelize.define('CongeActionRequest', {
    id: {
      type: DataTypes.UUID,
      primaryKey: true,
      defaultValue: DataTypes.UUIDV4,
    },
    conge_id:      { type: DataTypes.UUID, allowNull: true },
    entreprise_id: { type: DataTypes.UUID, allowNull: false },
    utilisateur_id:{ type: DataTypes.UUID, allowNull: false },
    type:   { type: DataTypes.ENUM('cancel', 'modify'), allowNull: false },
    statut: { type: DataTypes.ENUM('pending', 'approved', 'rejected'), allowNull: false, defaultValue: 'pending' },
    date_debut_demandee:         { type: DataTypes.DATEONLY, allowNull: true },
    date_fin_demandee:           { type: DataTypes.DATEONLY, allowNull: true },
    debut_demi_journee_demandee: { type: DataTypes.ENUM('matin', 'apres_midi'), allowNull: true },
    fin_demi_journee_demandee:   { type: DataTypes.ENUM('matin', 'apres_midi'), allowNull: true },
    commentaire_employe: { type: DataTypes.TEXT, allowNull: false },
    commentaire_admin:   { type: DataTypes.TEXT, allowNull: true },
  }, {
    tableName: 'conge_action_request',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  });
};
