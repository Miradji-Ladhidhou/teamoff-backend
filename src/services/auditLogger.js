const { AuditLog } = require('../models');

async function logAction({ action, entity, entity_id, user_id, entreprise_id, ip, userAgent, metadata }) {
  try {
    await AuditLog.create({
      action,
      entity,
      entity_id,
      user_id,
      entreprise_id,
      ip_address: ip,
      user_agent: userAgent,
      metadata
    });
  } catch (err) {
    console.error('Erreur audit logger:', err);
  }
}

module.exports = { logAction };