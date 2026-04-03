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
    const payload = {
      entreprise_id: entreprise.id,
      user_id: options?.userId || null,
      action: 'entreprise_created',
      transaction: options?.transaction || null,
      metadata: {
        new: entreprise.toJSON()
      }
    };

    if (options?.transaction?.afterCommit) {
      options.transaction.afterCommit(() => logAction({ ...payload, transaction: null }));
      return;
    }

    await logAction(payload);
  });

  Entreprise.afterUpdate(async (entreprise, options) => {

    const changedFields = entreprise.changed() || [];

    const oldValues = {};
    changedFields.forEach(field => {
      oldValues[field] = entreprise._previousDataValues[field];
    });

    const payload = {
      entreprise_id: entreprise.id,
      user_id: options?.userId || null,
      action: 'entreprise_updated',
      transaction: options?.transaction || null,
      metadata: {
        changed_fields: changedFields,
        new: entreprise.toJSON(),
        old: entreprise._previousDataValues
      }
    };

    if (options?.transaction?.afterCommit) {
      options.transaction.afterCommit(() => logAction({ ...payload, transaction: null }));
      return;
    }

    await logAction(payload);
  });

  Entreprise.afterDestroy(async (entreprise, options) => {
    const payload = {
      entreprise_id: entreprise.id,
      user_id: options?.userId || null,
      action: 'entreprise_deleted',
      transaction: options?.transaction || null,
      metadata: {
        old: entreprise.toJSON()
      }
    };

    if (options?.transaction?.afterCommit) {
      options.transaction.afterCommit(() => logAction({ ...payload, transaction: null }));
      return;
    }

    await logAction(payload);
  });

  return Entreprise;
};