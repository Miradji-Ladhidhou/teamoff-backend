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

Entreprise.hasMany(Utilisateur, { foreignKey: 'entreprise_id' });
Utilisateur.belongsTo(Entreprise, { foreignKey: 'entreprise_id' });

Entreprise.hasMany(CongeType, { foreignKey: 'entreprise_id' });
CongeType.belongsTo(Entreprise, { foreignKey: 'entreprise_id' });

CompteurConges.belongsTo(Utilisateur, { foreignKey: 'utilisateur_id' });
CompteurConges.belongsTo(CongeType, { foreignKey: 'conge_type_id' });

Conge.belongsTo(Utilisateur, { foreignKey: 'utilisateur_id' });
Conge.belongsTo(Entreprise, { foreignKey: 'entreprise_id' });
Conge.belongsTo(CongeType, { foreignKey: 'conge_type_id' });

Notification.belongsTo(Utilisateur, { foreignKey: 'utilisateur_id' });
Notification.belongsTo(Entreprise, { foreignKey: 'entreprise_id' });

AuditLog.belongsTo(Entreprise, { foreignKey: 'entreprise_id' });
AuditLog.belongsTo(Utilisateur, { foreignKey: 'utilisateur_id' });

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
