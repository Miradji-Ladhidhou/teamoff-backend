// models/index.js
const { Sequelize, DataTypes } = require('sequelize');
require('dotenv').config();

// Connexion à la base
const sequelize = new Sequelize(process.env.DATABASE_URL, {
  dialect: 'postgres',
  logging: false,
});

// ======================
// Import des modèles avec DataTypes
// ======================
const Entreprise = require('./Entreprise')(sequelize, DataTypes);
const Utilisateur = require('./Utilisateur')(sequelize, DataTypes);
const CongeType = require('./CongeType')(sequelize, DataTypes);
const CompteurConges = require('./CompteurConges')(sequelize, DataTypes);
const Conge = require('./Conge')(sequelize, DataTypes);
const LeavePolicy = require('./LeavePolicy')(sequelize, DataTypes);
const JoursFeries = require('./JoursFeries')(sequelize, DataTypes);
const AuditLog = require('./AuditLog')(sequelize, DataTypes);
const Notification = require('./Notification')(sequelize, DataTypes);
const SystemSetting = require('./SystemSetting')(sequelize, DataTypes);
const HolidayTemplate = require('./HolidayTemplate')(sequelize, DataTypes);
const HolidayTemplateItem = require('./HolidayTemplateItem')(sequelize, DataTypes);
const Absence = require('./Absence')(sequelize, DataTypes);
const MouvementSolde = require('./MouvementSolde')(sequelize, DataTypes);
const CongeActionRequest = require('./CongeActionRequest')(sequelize, DataTypes);

// ======================
// Associations
// ======================

// ----------------------
// Entreprise relations
// ----------------------
// onDelete values match DB FK constraints; hooks:true would fire child beforeDestroy/afterDestroy
// but is intentionally omitted — the DB cascade is the enforcement layer (no child hooks needed).
Entreprise.hasMany(Utilisateur,    { foreignKey: 'entreprise_id', as: 'utilisateurs',     onDelete: 'CASCADE'   });
Entreprise.hasMany(Conge,          { foreignKey: 'entreprise_id', as: 'conges',            onDelete: 'CASCADE'   });
Entreprise.hasMany(CongeType,      { foreignKey: 'entreprise_id', as: 'conge_types',       onDelete: 'CASCADE'   });
Entreprise.hasMany(JoursFeries,    { foreignKey: 'entreprise_id', as: 'jours_feries',      onDelete: 'CASCADE'   });
Entreprise.hasMany(AuditLog,       { foreignKey: 'entreprise_id', as: 'audit_logs',        onDelete: 'SET NULL'  });
Entreprise.hasMany(Notification,   { foreignKey: 'entreprise_id', as: 'notifications',     onDelete: 'CASCADE'   });
Entreprise.hasMany(CompteurConges, { foreignKey: 'entreprise_id', as: 'compteurs_conges',  onDelete: 'CASCADE'   });
Entreprise.hasMany(Absence,        { foreignKey: 'entreprise_id', as: 'absences',          onDelete: 'CASCADE'   });
Entreprise.hasOne(LeavePolicy,     { foreignKey: 'entreprise_id', as: 'leave_policy',      onDelete: 'CASCADE'   });
// HolidayTemplate: source_entreprise_id → SET NULL (templates survivent à la suppression de l'entreprise source)
Entreprise.hasMany(HolidayTemplate, { foreignKey: 'source_entreprise_id', as: 'holiday_templates', onDelete: 'SET NULL' });

// ----------------------
// Utilisateur relations
// ----------------------
Utilisateur.belongsTo(Entreprise, { foreignKey: 'entreprise_id', as: 'entreprise' });
Utilisateur.hasMany(Conge, { foreignKey: 'utilisateur_id', as: 'conges' });
Utilisateur.hasMany(CompteurConges, { foreignKey: 'utilisateur_id', as: 'compteurs_conges' });
Utilisateur.hasMany(AuditLog, { foreignKey: 'user_id', as: 'audit_logs' });
Utilisateur.hasMany(Notification, { foreignKey: 'utilisateur_id', as: 'notifications' });
Utilisateur.hasMany(Absence, { foreignKey: 'utilisateur_id', as: 'absences' });

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

// ----------------------
// Absence relations
// ----------------------
Absence.belongsTo(Utilisateur, { foreignKey: 'utilisateur_id', as: 'utilisateur' });
Absence.belongsTo(Entreprise, { foreignKey: 'entreprise_id', as: 'entreprise' });

// ----------------------
// MouvementSolde relations
// ----------------------
MouvementSolde.belongsTo(Utilisateur, { foreignKey: 'utilisateur_id', as: 'utilisateur' });
MouvementSolde.belongsTo(Entreprise, { foreignKey: 'entreprise_id', as: 'entreprise' });
MouvementSolde.belongsTo(CongeType, { foreignKey: 'conge_type_id', as: 'conge_type' });
Utilisateur.hasMany(MouvementSolde, { foreignKey: 'utilisateur_id', as: 'mouvements_solde' });
Entreprise.hasMany(MouvementSolde, { foreignKey: 'entreprise_id', as: 'mouvements_solde', onDelete: 'CASCADE' });

// ----------------------
// CongeActionRequest relations
// ----------------------
CongeActionRequest.belongsTo(Conge,        { foreignKey: 'conge_id',       as: 'conge' });
CongeActionRequest.belongsTo(Utilisateur,  { foreignKey: 'utilisateur_id', as: 'utilisateur' });
CongeActionRequest.belongsTo(Entreprise,   { foreignKey: 'entreprise_id',  as: 'entreprise' });
Conge.hasMany(CongeActionRequest,          { foreignKey: 'conge_id',       as: 'action_requests', onDelete: 'CASCADE' });
Entreprise.hasMany(CongeActionRequest,     { foreignKey: 'entreprise_id',  as: 'conge_action_requests', onDelete: 'CASCADE' });

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
  LeavePolicy,
  JoursFeries,
  AuditLog,
  Notification,
  SystemSetting,
  HolidayTemplate,
  HolidayTemplateItem,
  Absence,
  MouvementSolde,
  CongeActionRequest,
};