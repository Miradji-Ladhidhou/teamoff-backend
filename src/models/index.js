// models/index.js
const { Sequelize } = require('sequelize');
require('dotenv').config();

const sequelize = new Sequelize(process.env.DATABASE_URL, {
  dialect: 'postgres',
  logging: false,
});

// ======================
// Import des modèles
// ======================
const Entreprise = require('./Entreprise')(sequelize);
const Utilisateur = require('./Utilisateur')(sequelize);
const CongeType = require('./CongeType')(sequelize);
const CompteurConges = require('./CompteurConges')(sequelize);
const Conge = require('./Conge')(sequelize);
const JoursFeries = require('./JoursFeries')(sequelize);
const AuditLog = require('./AuditLog')(sequelize);
const Notification = require('./Notification')(sequelize);
const SystemSetting = require('./SystemSetting')(sequelize);
const HolidayTemplate = require('./HolidayTemplate')(sequelize);
const HolidayTemplateItem = require('./HolidayTemplateItem')(sequelize);

// ======================
// Associations
// ======================

// ----------------------
// Entreprise relations
// ----------------------
Entreprise.hasMany(Utilisateur, { foreignKey: 'entreprise_id', as: 'utilisateurs' });
Entreprise.hasMany(Conge, { foreignKey: 'entreprise_id', as: 'conges' });
Entreprise.hasMany(CongeType, { foreignKey: 'entreprise_id', as: 'conge_types' });
Entreprise.hasMany(JoursFeries, { foreignKey: 'entreprise_id', as: 'jours_feries' });
Entreprise.hasMany(AuditLog, { foreignKey: 'entreprise_id', as: 'audit_logs' });
Entreprise.hasMany(Notification, { foreignKey: 'entreprise_id', as: 'notifications' });
Entreprise.hasMany(CompteurConges, { foreignKey: 'entreprise_id', as: 'compteurs_conges' });

// ----------------------
// Utilisateur relations
// ----------------------
Utilisateur.belongsTo(Entreprise, { foreignKey: 'entreprise_id', as: 'entreprise' });
Utilisateur.hasMany(Conge, { foreignKey: 'utilisateur_id', as: 'conges' });
Utilisateur.hasMany(CompteurConges, { foreignKey: 'utilisateur_id', as: 'compteurs_conges' });
Utilisateur.hasMany(AuditLog, { foreignKey: 'user_id', as: 'audit_logs' });
Utilisateur.hasMany(Notification, { foreignKey: 'utilisateur_id', as: 'notifications' });

// ----------------------
// CongeType relations
// ----------------------
CongeType.belongsTo(Entreprise, { foreignKey: 'entreprise_id', as: 'entreprise' });
CongeType.hasMany(Conge, { foreignKey: 'conge_type_id', as: 'conges' });
CongeType.hasMany(CompteurConges, { foreignKey: 'conge_type_id', as: 'compteurs_conges' });

// ----------------------
// Conge relations
// ----------------------
Conge.belongsTo(Utilisateur, { foreignKey: 'utilisateur_id', as: 'utilisateur' });
Conge.belongsTo(Entreprise, { foreignKey: 'entreprise_id', as: 'entreprise' });
Conge.belongsTo(CongeType, { foreignKey: 'conge_type_id', as: 'conge_type' });

// ----------------------
// CompteurConges relations
// ----------------------
CompteurConges.belongsTo(Utilisateur, { foreignKey: 'utilisateur_id', as: 'utilisateur' });
CompteurConges.belongsTo(CongeType, { foreignKey: 'conge_type_id', as: 'conge_type' });
CompteurConges.belongsTo(Entreprise, { foreignKey: 'entreprise_id', as: 'entreprise' });

// ----------------------
// JoursFeries relations
// ----------------------
JoursFeries.belongsTo(Entreprise, { foreignKey: 'entreprise_id', as: 'entreprise' });

// ----------------------
// AuditLog relations
// ----------------------
AuditLog.belongsTo(Utilisateur, { foreignKey: 'user_id', as: 'utilisateur' });
AuditLog.belongsTo(Entreprise, { foreignKey: 'entreprise_id', as: 'entreprise' });

// ----------------------
// Notification relations
// ----------------------
Notification.belongsTo(Utilisateur, { foreignKey: 'utilisateur_id', as: 'utilisateur' });
Notification.belongsTo(Entreprise, { foreignKey: 'entreprise_id', as: 'entreprise' });

// ----------------------
// HolidayTemplate relations
// ----------------------
HolidayTemplate.belongsTo(Utilisateur, { foreignKey: 'created_by', as: 'creator' });
HolidayTemplate.belongsTo(Entreprise, { foreignKey: 'source_entreprise_id', as: 'sourceEntreprise' });
HolidayTemplate.hasMany(HolidayTemplateItem, { foreignKey: 'template_id', as: 'items', onDelete: 'CASCADE' });
HolidayTemplateItem.belongsTo(HolidayTemplate, { foreignKey: 'template_id', as: 'template' });

// ======================
// Export
// ======================
module.exports = {
  sequelize,
  Entreprise,
  Utilisateur,
  CongeType,
  CompteurConges,
  Conge,
  JoursFeries,
  AuditLog,
  Notification,
  SystemSetting,
  HolidayTemplate,
  HolidayTemplateItem,
};
