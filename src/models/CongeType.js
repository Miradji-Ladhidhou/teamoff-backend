module.exports = (sequelize, DataTypes) => {
  return sequelize.define('CongeType', {
    id: {
      type: DataTypes.UUID,
      primaryKey: true,
      defaultValue: DataTypes.UUIDV4,
    },

    entreprise_id: {
      type: DataTypes.UUID,
      allowNull: false,
      references: { model: 'entreprise', key: 'id' }
    },

    code: {
      type: DataTypes.STRING(20),
      allowNull: false,
    },

    libelle: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },

    quota_annuel: {
      type: DataTypes.DECIMAL(5,2),
      allowNull: true,
      validate: {
        min: 0
      }
    },

    demi_journee_autorisee: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    }

  }, {
    tableName: 'conge_type',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',

    indexes: [
      { fields: ['entreprise_id'] },
    ],

    uniqueKeys: {
      entreprise_code_unique: {
        fields: ['entreprise_id', 'code'],
      },
    },

    validate: {
      quota_non_negatif() {
        if (this.quota_annuel !== null && this.quota_annuel < 0) {
          throw new Error('quota_annuel doit être >= 0');
        }
      }
    }
  });
};