require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const { Op } = require('sequelize');
const {
  sequelize,
  Utilisateur,
  Entreprise,
  Conge,
  CongeType,
  CompteurConges,
  JoursFeries,
  AuditLog,
  Notification,
  HolidayTemplate,
  HolidayTemplateItem,
} = require('../src/models');

async function run() {
  await sequelize.authenticate();

  const superAdmins = await Utilisateur.findAll({
    where: { role: 'super_admin' },
    attributes: ['id', 'entreprise_id', 'email'],
  });

  if (superAdmins.length === 0) {
    throw new Error('Aucun super_admin trouve. Nettoyage annule pour eviter de verrouiller la plateforme.');
  }

  const keepUserIds = superAdmins.map((u) => u.id);
  const keepEntrepriseIds = [...new Set(superAdmins.map((u) => u.entreprise_id).filter(Boolean))];

  const stats = {};

  await sequelize.transaction(async (transaction) => {
    stats.notifications = await Notification.destroy({ where: {}, transaction });
    stats.auditLogs = await AuditLog.destroy({ where: {}, transaction });
    stats.conges = await Conge.destroy({ where: {}, transaction });
    stats.compteurs = await CompteurConges.destroy({ where: {}, transaction });
    stats.joursFeries = await JoursFeries.destroy({ where: {}, transaction });
    stats.holidayTemplateItems = await HolidayTemplateItem.destroy({ where: {}, transaction });
    stats.holidayTemplates = await HolidayTemplate.destroy({ where: {}, transaction });
    stats.congeTypes = await CongeType.destroy({ where: {}, transaction });

    stats.usersDeleted = await Utilisateur.destroy({
      where: { id: { [Op.notIn]: keepUserIds } },
      transaction,
    });

    if (keepEntrepriseIds.length > 0) {
      stats.entreprisesDeleted = await Entreprise.destroy({
        where: { id: { [Op.notIn]: keepEntrepriseIds } },
        transaction,
      });

      await Entreprise.update(
        {
          politique_conges: {},
          parametres: {},
          statut: 'active',
        },
        {
          where: { id: { [Op.in]: keepEntrepriseIds } },
          transaction,
        }
      );
    } else {
      stats.entreprisesDeleted = await Entreprise.destroy({ where: {}, transaction });
    }

    await Utilisateur.update(
      {
        statut: 'actif',
        failed_login_attempts: 0,
        locked_until: null,
        service: null,
      },
      {
        where: { id: { [Op.in]: keepUserIds } },
        transaction,
      }
    );
  });

  console.log(JSON.stringify({
    ok: true,
    keptSuperAdmins: superAdmins.map((u) => ({ id: u.id, email: u.email, entreprise_id: u.entreprise_id })),
    stats,
  }, null, 2));
}

run()
  .catch((error) => {
    console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
    process.exit(1);
  })
  .finally(async () => {
    try {
      await sequelize.close();
    } catch (_) {
      // Ignore close errors in cleanup script
    }
  });
