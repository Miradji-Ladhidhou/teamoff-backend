const { logAction } = require('../services/auditLogger');

module.exports = (sequelize, DataTypes) => {
  const LeavePolicy = sequelize.define('LeavePolicy', {
    id: {
      type: DataTypes.UUID,
      primaryKey: true,
      defaultValue: DataTypes.UUIDV4,
    },

    entreprise_id: {
      type: DataTypes.UUID,
      allowNull: false,
      references: {
        model: 'entreprise',
        key: 'id',
      },
      unique: true,
    },

    allow_modify_validated: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },

    allow_cancel_validated: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },

    min_notice_days: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 2,
    },

    max_backdate_days: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },

    require_manager_approval: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },

    require_admin_approval: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
  }, {
    tableName: 'leave_policy',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    indexes: [
      { fields: ['entreprise_id'], unique: true },
    ],
  });

  /**
   * Audit: enregistrer chaque changement de politique
   */
  LeavePolicy.afterUpdate(async (policy, options) => {
    const changedFields = policy.changed() || [];

    const oldValues = {};
    changedFields.forEach(field => {
      oldValues[field] = policy._previousDataValues[field];
    });

    const payload = {
      entreprise_id: policy.entreprise_id,
      user_id: options?.userId || null,
      action: 'leave_policy_updated',
      transaction: options?.transaction || null,
      metadata: {
        changed_fields: changedFields,
        new: policy.toJSON(),
        old: oldValues,
      },
    };

    if (options?.transaction?.afterCommit) {
      options.transaction.afterCommit(() => logAction({ ...payload, transaction: null }));
      return;
    }

    await logAction(payload);
  });

  LeavePolicy.afterCreate(async (policy, options) => {
    const payload = {
      entreprise_id: policy.entreprise_id,
      user_id: options?.userId || null,
      action: 'leave_policy_created',
      transaction: options?.transaction || null,
      metadata: {
        new: policy.toJSON(),
      },
    };

    if (options?.transaction?.afterCommit) {
      options.transaction.afterCommit(() => logAction({ ...payload, transaction: null }));
      return;
    }

    await logAction(payload);
  });

  return LeavePolicy;
};
