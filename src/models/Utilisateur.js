const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  return sequelize.define('Utilisateur', {
    id: {
      type: DataTypes.UUID,
      primaryKey: true,
      defaultValue: DataTypes.UUIDV4,
    },
    entreprise_id: {
      type: DataTypes.UUID,
      allowNull: false,
      field: 'entreprise_id',
    },
    nom: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    email: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    role: {
      type: DataTypes.ENUM('super_admin','admin_entreprise','manager','employe'),
      allowNull: false,
    },
    password_hash: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    statut: {
      type: DataTypes.ENUM('actif', 'inactif', 'en_attente'),
      allowNull: false,
      defaultValue: 'en_attente',
    },
  }, {
    tableName: 'utilisateur',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    indexes: [
      { fields: ['entreprise_id'] },
      { fields: ['entreprise_id', 'role'] },
    ],
    uniqueKeys: {
      entreprise_email_unique: {
        fields: ['entreprise_id', 'email'],
      },
    },
  });
};
