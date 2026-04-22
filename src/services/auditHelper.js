// src/services/auditHelper.js
const { AuditLog } = require('../models'); // ton modèle AuditLog
const auditActions = require('./auditActions');
const logger = require('../utils/logger');

function resolveEntrepriseId({ performedBy, entity, entityId, metadata }) {
  if (performedBy?.entreprise_id) return performedBy.entreprise_id;

  if (entity === 'entreprise' && entityId) return entityId;

  if (metadata?.entreprise_id) return metadata.entreprise_id;

  if (entity === 'entreprise' && metadata?.new?.id) return metadata.new.id;

  return null;
}

/**
 * Fonction interne pour créer un audit dans la base
 */
async function logAudit({ action, entity, entity_id, user_id, entreprise_id, ip, userAgent, metadata }) {
  if (!entreprise_id) {
    return;
  }

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
    logger.error('Erreur logAudit:', err);
  }
}

/**
 * Helper générique pour auditer une action
 */
async function auditEntity({ action, entity, entityId, performedBy, req, metadata = {} }) {
  try {
    const entrepriseId = resolveEntrepriseId({
      performedBy,
      entity,
      entityId,
      metadata,
    });

    await logAudit({
      action,
      entity,
      entity_id: entityId || null,
      user_id: performedBy?.id || null,
      entreprise_id: entrepriseId,
      ip: req?.ip || null,
      userAgent: req?.get?.('User-Agent') || null,
      metadata
    });
  } catch (err) {
    logger.error('Erreur audit helper:', err);
  }
}

// ==================
// Audit par entité
// ==================

const auditEntreprise = {
  created: (entreprise, performedBy, req) =>
    auditEntity({ action: auditActions.ENTREPRISE_CREATED, entity: 'entreprise', entityId: entreprise.id, performedBy, req, metadata: { nom: entreprise.nom } }),
  updated: (entreprise, performedBy, req) =>
    auditEntity({ action: auditActions.ENTREPRISE_UPDATED, entity: 'entreprise', entityId: entreprise.id, performedBy, req }),
  deleted: (entreprise, performedBy, req) =>
    auditEntity({ action: auditActions.ENTREPRISE_DELETED, entity: 'entreprise', entityId: entreprise.id, performedBy, req })
};

const auditUser = {
  created: (user, performedBy, req) =>
    auditEntity({ action: auditActions.USER_CREATED, entity: 'user', entityId: user.id, performedBy, req, metadata: { email: user.email, role: user.role } }),
  updated: (user, performedBy, req) =>
    auditEntity({ action: auditActions.USER_UPDATED, entity: 'user', entityId: user.id, performedBy, req }),
  deleted: (user, performedBy, req) =>
    auditEntity({ action: auditActions.USER_DELETED, entity: 'user', entityId: user.id, performedBy, req }),
  roleChanged: (user, oldRole, newRole, performedBy, req) =>
    auditEntity({ action: auditActions.ROLE_CHANGED, entity: 'user', entityId: user.id, performedBy, req, metadata: { oldRole, newRole } })
};

const auditConge = {
  created: (conge, performedBy, req) =>
    auditEntity({ action: auditActions.CONGE_CREATED, entity: 'conge', entityId: conge.id, performedBy, req }),
  updated: (conge, performedBy, req) =>
    auditEntity({ action: auditActions.CONGE_UPDATED, entity: 'conge', entityId: conge.id, performedBy, req }),
  deleted: (conge, performedBy, req) =>
    auditEntity({ action: auditActions.CONGE_DELETED, entity: 'conge', entityId: conge.id, performedBy, req }),
  approved: (conge, performedBy, req) =>
    auditEntity({ action: auditActions.CONGE_APPROVED, entity: 'conge', entityId: conge.id, performedBy, req }),
  rejected: (conge, performedBy, req) =>
    auditEntity({ action: auditActions.CONGE_REJECTED, entity: 'conge', entityId: conge.id, performedBy, req })
};

const auditFerie = {
  created: (ferie, performedBy, req) =>
    auditEntity({ action: auditActions.FERIE_CREATED, entity: 'ferie', entityId: ferie.id, performedBy, req }),
  updated: (ferie, performedBy, req) =>
    auditEntity({ action: auditActions.FERIE_UPDATED, entity: 'ferie', entityId: ferie.id, performedBy, req }),
  deleted: (ferie, performedBy, req) =>
    auditEntity({ action: auditActions.FERIE_DELETED, entity: 'ferie', entityId: ferie.id, performedBy, req })
};

const auditAuth = {
  loginSuccess: (user, req) =>
    auditEntity({ action: auditActions.LOGIN_SUCCESS, entity: 'auth', entityId: user?.id, performedBy: user, req }),
  loginFailed: (email, req) =>
    auditEntity({ action: auditActions.LOGIN_FAILED, entity: 'auth', entityId: null, performedBy: null, req, metadata: { email } }),
  logout: (user, req) =>
    auditEntity({ action: auditActions.LOGOUT, entity: 'auth', entityId: user?.id, performedBy: user, req }),
  passwordChanged: (user, req) =>
    auditEntity({ action: auditActions.PASSWORD_CHANGED, entity: 'auth', entityId: user.id, performedBy: user, req }),
  passwordResetRequest: (email, req) =>
    auditEntity({ action: auditActions.PASSWORD_RESET_REQUEST, entity: 'auth', entityId: null, performedBy: null, req, metadata: { email } }),
  passwordResetSuccess: (user, req) =>
    auditEntity({ action: auditActions.PASSWORD_RESET_SUCCESS, entity: 'auth', entityId: user.id, performedBy: user, req })
};

module.exports = {
  auditEntity,
  auditEntreprise,
  auditUser,
  auditConge,
  auditFerie,
  auditAuth
};