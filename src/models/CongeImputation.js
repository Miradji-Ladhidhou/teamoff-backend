module.exports = (sequelize, DataTypes) => sequelize.define('CongeImputation', {
  id: {
    type: DataTypes.UUID,
    primaryKey: true,
    defaultValue: DataTypes.UUIDV4,
  },
  conge_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'conge', key: 'id' },
  },
  compteur_conges_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'compteur_conges', key: 'id' },
  },
  annee: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  jours: {
    type: DataTypes.DECIMAL(6, 2),
    allowNull: false,
  },
}, {
  tableName: 'conge_imputation',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  indexes: [
    { fields: ['conge_id'] },
    { fields: ['compteur_conges_id'] },
    { fields: ['conge_id', 'annee'], unique: true },
  ],
});
