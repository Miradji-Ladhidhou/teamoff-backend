const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {

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

    logo: {
      type: DataTypes.STRING(255),
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

  /**
   * Hook création
   */
  Entreprise.afterCreate(async (entreprise, options) => {
    await logAction({
      entrepriseId: entreprise.id,
      utilisateurId: options.userId || null,
      action: 'entreprise_created',
      meta: {
        new: entreprise.toJSON()
      }
    });
  });

  /**
   * Hook modification
   */
  Entreprise.afterUpdate(async (entreprise, options) => {

    const changedFields = entreprise.changed() || [];

    const oldValues = {};
    changedFields.forEach(field => {
      oldValues[field] = entreprise._previousDataValues[field];
    });

    await logAction({
      entrepriseId: entreprise.id,
      utilisateurId: options.userId || null,
      action: 'entreprise_updated',
      meta: {
        changed_fields: changedFields,
        new: entreprise.toJSON(),
        old: entreprise._previousDataValues
      }
    });
  });

  /**
   * Hook suppression
   */
  Entreprise.afterDestroy(async (entreprise, options) => {
    await logAction({
      entrepriseId: entreprise.id,
      utilisateurId: options.userId || null,
      action: 'entreprise_deleted',
      meta: {
        old: entreprise.toJSON()
      }
    });
  });

  return Entreprise;
};