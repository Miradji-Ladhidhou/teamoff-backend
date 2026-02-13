const { Sequelize } = require('sequelize');
require('dotenv').config();

const sequelize = new Sequelize(process.env.DATABASE_URL, {
  dialect: 'postgres',
  logging: false,
});

const Entreprise = require('./Entreprise')(sequelize);
const Utilisateur = require('./Utilisateur')(sequelize);
const CongeType = require('./CongeType')(sequelize);
const CompteurConges = require('./CompteurConges')(sequelize);
const JoursFeries = require('./JoursFeries')(sequelize);
const Conge = require('./Conge')(sequelize);
const AuditLog = require('./AuditLog')(sequelize);
const Notification = require('./Notification')(sequelize);

/* ======================
   Associations
====================== */

// Entreprise → Utilisateurs / Congés / CongeTypes / JoursFeries / AuditLog / Notifications
Entreprise.hasMany(Utilisateur, { foreignKey: 'entreprise_id', as: 'utilisateurs' });
Entreprise.hasMany(Conge, { foreignKey: 'entreprise_id', as: 'conges' });
Entreprise.hasMany(CongeType, { foreignKey: 'entreprise_id', as: 'conge_types' });
Entreprise.hasMany(JoursFeries, { foreignKey: 'entreprise_id', as: 'jours_feries' });
Entreprise.hasMany(AuditLog, { foreignKey: 'entreprise_id', as: 'audit_logs' });
Entreprise.hasMany(Notification, { foreignKey: 'entreprise_id', as: 'notifications' });

// Utilisateur → Congés / CompteurConges / AuditLog / Notifications
Utilisateur.hasMany(Conge, { foreignKey: 'utilisateur_id', as: 'conges' });
Utilisateur.hasMany(CompteurConges, { foreignKey: 'utilisateur_id', as: 'compteurs_conges' });
Utilisateur.hasMany(AuditLog, { foreignKey: 'utilisateur_id', as: 'audit_logs' });
Utilisateur.hasMany(Notification, { foreignKey: 'utilisateur_id', as: 'notifications' });

// CongeType → Congés / CompteurConges
CongeType.hasMany(Conge, { foreignKey: 'conge_type_id', as: 'conges' });
CongeType.hasMany(CompteurConges, { foreignKey: 'conge_type_id', as: 'compteurs_conges' });

// Associations inverses
Utilisateur.belongsTo(Entreprise, { foreignKey: 'entreprise_id', as: 'entreprise' });
Conge.belongsTo(Utilisateur, { foreignKey: 'utilisateur_id', as: 'utilisateur' });
Conge.belongsTo(Entreprise, { foreignKey: 'entreprise_id', as: 'entreprise' });
Conge.belongsTo(CongeType, { foreignKey: 'conge_type_id', as: 'conge_type' });
CompteurConges.belongsTo(Utilisateur, { foreignKey: 'utilisateur_id', as: 'utilisateur' });
CompteurConges.belongsTo(CongeType, { foreignKey: 'conge_type_id', as: 'conge_type' });
Notification.belongsTo(Utilisateur, { foreignKey: 'utilisateur_id', as: 'utilisateur' });
Notification.belongsTo(Entreprise, { foreignKey: 'entreprise_id', as: 'entreprise' });
AuditLog.belongsTo(Utilisateur, { foreignKey: 'utilisateur_id', as: 'utilisateur' });
AuditLog.belongsTo(Entreprise, { foreignKey: 'entreprise_id', as: 'entreprise' });
JoursFeries.belongsTo(Entreprise, { foreignKey: 'entreprise_id', as: 'entreprise' });


module.exports = {
  sequelize,
  Entreprise,
  Utilisateur,
  CongeType,
  CompteurConges,
  JoursFeries,
  Conge,
  AuditLog,
  Notification,
};
