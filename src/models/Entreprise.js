const { logAction } = require('../services/auditLogger');

module.exports = (sequelize, DataTypes) => {

  const Entreprise = sequelize.define('Entreprise', {
    id: {
      type: DataTypes.UUID,
      primaryKey: true,
      defaultValue: DataTypes.UUIDV4,
    },

    nom: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },

    politique_conges: {
      type: DataTypes.JSONB,
      allowNull: false,
      defaultValue: {},
    },

    parametres: {
      type: DataTypes.JSONB,
      allowNull: false,
      defaultValue: {},
    },

    statut: {
      type: DataTypes.ENUM('active', 'inactive', 'suspendue'),
      allowNull: false,
      defaultValue: 'active',
    },

  }, {
    tableName: 'entreprise',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  });

  Entreprise.afterCreate(async (entreprise, options) => {
    await logAction({
      entreprise_id: entreprise.id,
      user_id: options?.userId || null,
      action: 'entreprise_created',
      metadata: {
        new: entreprise.toJSON()
      }
    });
  });

  Entreprise.afterUpdate(async (entreprise, options) => {

    const changedFields = entreprise.changed() || [];

    const oldValues = {};
    changedFields.forEach(field => {
      oldValues[field] = entreprise._previousDataValues[field];
    });

    await logAction({
      entreprise_id: entreprise.id,
      user_id: options?.userId || null,
      action: 'entreprise_updated',
      metadata: {
        changed_fields: changedFields,
        new: entreprise.toJSON(),
        old: entreprise._previousDataValues
      }
    });
  });

  Entreprise.afterDestroy(async (entreprise, options) => {
    await logAction({
      entreprise_id: entreprise.id,
      user_id: options?.userId || null,
      action: 'entreprise_deleted',
      metadata: {
        old: entreprise.toJSON()
      }
    });
  });

  return Entreprise;
};