async function logAction({ action, entity, entity_id, user_id, entreprise_id, ip, userAgent, metadata, transaction = null }) {
  try {
    const { AuditLog } = require('../models');
    await AuditLog.create({
      action,
      entity,
      entity_id,
      user_id,
      entreprise_id,
      ip_address: ip,
      user_agent: userAgent,
      metadata
    }, {
      transaction,
    });
  } catch (err) {
    console.error('Erreur audit logger:', err);
  }
}

module.exports = { logAction };