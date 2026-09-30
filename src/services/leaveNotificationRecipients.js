const { Utilisateur } = require('../models');

async function getLeaveNotificationRecipients({ entrepriseId, service, workflow, stage = 'manager', reservation = false, transaction = null }) {
  const managersNeeded = workflow === 'manager'
    || workflow === 'manager_only'
    || (workflow === 'manager_admin' && stage === 'manager')
    || (reservation && workflow === 'manager_admin');
  const adminsNeeded = workflow === 'admin_only'
    || (workflow === 'manager_admin' && stage === 'admin')
    || (reservation && workflow === 'manager_admin')
    || (reservation && workflow === 'auto');

  if (!managersNeeded && !adminsNeeded) return [];

  const managers = managersNeeded ? await Utilisateur.findAll({
    where: {
      entreprise_id: entrepriseId,
      role: 'manager',
      statut: 'actif',
      ...(service ? { service } : {}),
    },
    transaction,
  }) : [];

  let scopedManagers = managers;
  if (managersNeeded && service && managers.length === 0) {
    scopedManagers = await Utilisateur.findAll({
      where: { entreprise_id: entrepriseId, role: 'manager', statut: 'actif' },
      transaction,
    });
  }

  const admins = adminsNeeded ? await Utilisateur.findAll({
    where: { entreprise_id: entrepriseId, role: 'admin_entreprise', statut: 'actif' },
    transaction,
  }) : [];

  return [...new Map([...scopedManagers, ...admins].map((recipient) => [recipient.id, recipient])).values()];
}

module.exports = { getLeaveNotificationRecipients };
