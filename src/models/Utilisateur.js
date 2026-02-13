const { DataTypes } = require('sequelize');
const bcrypt = require('bcrypt');

module.exports = (sequelize) =>
  sequelize.define(
    'Utilisateur',
    {
      id: {
        type: DataTypes.UUID,
        primaryKey: true,
        defaultValue: DataTypes.UUIDV4,
      },
      entreprise_id: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      nom: {
        type: DataTypes.STRING(255),
        allowNull: false,
      },
      email: {
        type: DataTypes.STRING(255),
        allowNull: false,
        unique: true,
      },
      role: {
        type: DataTypes.ENUM(
          'super_admin',
          'admin_entreprise',
          'manager',
          'employe'
        ),
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
    },
    {
      tableName: 'utilisateur',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      indexes: [
        { fields: ['entreprise_id'] },
        { fields: ['entreprise_id', 'role'] },
      ],
      hooks: {
        beforeCreate: async (utilisateur) => {
          if (utilisateur.password_hash) {
            utilisateur.password_hash = await bcrypt.hash(utilisateur.password_hash, 10);
          }
        },
        beforeUpdate: async (utilisateur) => {
          if (utilisateur.changed('password_hash')) {
            utilisateur.password_hash = await bcrypt.hash(utilisateur.password_hash, 10);
          }
        },
      },
    }
  );
