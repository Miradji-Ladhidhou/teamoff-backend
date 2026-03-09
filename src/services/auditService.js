const { AuditLog } = require('../models');

async function logAction({
  entrepriseId,
  utilisateurId = null,
  action,
  meta = {}
}) {
  return AuditLog.create({
    entreprise_id: entrepriseId,
    utilisateur_id: utilisateurId,
    action,
    meta
  });
}

module.exports = {
  logAction
};