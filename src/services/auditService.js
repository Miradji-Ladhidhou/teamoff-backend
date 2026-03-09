const { AuditLog } = require('../models');

async function logAction({ entrepriseId, utilisateurId = null, action, meta = {} }) {
  if (!entrepriseId) {
    throw new Error('Entreprise ID requis pour la journalisation');
  }
  if (!action) {
    throw new Error('Action obligatoire pour la journalisation');
  }

  try {
    return await AuditLog.create({
      entreprise_id: entrepriseId,
      utilisateur_id: utilisateurId,
      action,
      meta: JSON.stringify(meta) // s'assure que c'est un JSON stockable
    });
  } catch (err) {
    console.error('Erreur audit log:', err);
    // Ne pas bloquer l'exécution principale si la log échoue
    return null;
  }
}

module.exports = { logAction };