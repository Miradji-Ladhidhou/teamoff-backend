// src/services/auditHelper.js
const { AuditLog, Utilisateur, Conge } = require('../models');
const auditActions = require('./auditActions');
const logger = require('../utils/logger');

// Pour les événements pré-authentification (LOGIN_FAILED, PASSWORD_RESET_REQUEST),
// l'utilisateur n'est pas encore identifié. On tente de résoudre l'entreprise
// depuis l'email tenté afin d'enrichir le log ; si l'email est inconnu, null est accepté.
async function resolveEntrepriseIdFromEmail(email) {
  if (!email) return null;
  try {
    const user = await Utilisateur.findOne({ where: { email }, attributes: ['entreprise_id'] });
    return user?.entreprise_id || null;
  } catch {
    return null;
  }
}

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
 * Résout l'entreprise_id depuis l'entité cible quand le performedBy est super_admin (entreprise_id = null).
 */
async function resolveEntrepriseIdFromEntity(entity, entityId) {
  if (!entityId) return null;
  try {
    if (entity === 'user' || entity === 'utilisateur') {
      const u = await Utilisateur.findByPk(entityId, { attributes: ['entreprise_id'] });
      return u?.entreprise_id || null;
    }
    if (entity === 'conge') {
      const c = await Conge.findByPk(entityId, { attributes: ['entreprise_id'] });
      return c?.entreprise_id || null;
    }
  } catch { /* non-bloquant */ }
  return null;
}

/**
 * Helper générique pour auditer une action
 */
async function auditEntity({ action, entity, entityId, performedBy, req, metadata = {} }) {
  try {
    let entrepriseId = resolveEntrepriseId({
      performedBy,
      entity,
      entityId,
      metadata,
    });

    // Fallback : super_admin sans entreprise_id → résoudre depuis l'entité cible
    if (!entrepriseId && entityId) {
      entrepriseId = await resolveEntrepriseIdFromEntity(entity, entityId);
    }

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
    auditEntity({ action: auditActions.CONGE_REJECTED, entity: 'conge', entityId: conge.id, performedBy, req }),

  // Action système (pas de req/user) — activation automatique d'une réservation N+1.
  activated: (conge, metadata = {}) =>
    logAudit({
      action: auditActions.CONGE_RESERVE_ACTIVATED,
      entity: 'conge',
      entity_id: conge.id,
      user_id: null,
      entreprise_id: conge.entreprise_id,
      ip: null,
      userAgent: null,
      metadata,
    }),

  // Balance insuffisante pour activer la réservation lors de ce cycle.
  skipped: (conge, metadata = {}) =>
    logAudit({
      action: auditActions.CONGE_RESERVE_SKIPPED,
      entity: 'conge',
      entity_id: conge.id,
      user_id: null,
      entreprise_id: conge.entreprise_id,
      ip: null,
      userAgent: null,
      metadata,
    }),
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

  // Événements pré-authentification : performedBy est null, entreprise_id résolu depuis l'email.
  // logAudit est appelé directement pour contourner auditEntity qui exige un performedBy.
  loginFailed: async (email, req) => {
    const entreprise_id = await resolveEntrepriseIdFromEmail(email);
    return logAudit({
      action: auditActions.LOGIN_FAILED,
      entity: 'auth',
      entity_id: null,
      user_id: null,
      entreprise_id,
      ip: req?.ip || null,
      userAgent: req?.get?.('User-Agent') || null,
      metadata: { email },
    });
  },

  // Verrouillage de compte après trop de tentatives échouées.
  // reqContext = { ip, userAgent } — optionnel, transmis depuis le contrôleur.
  accountLocked: (user, failedAttempts, lockedUntil, reqContext = {}) =>
    logAudit({
      action: auditActions.ACCOUNT_LOCKED,
      entity: 'utilisateur',
      entity_id: user.id,
      user_id: null,
      entreprise_id: user.entreprise_id,
      ip: reqContext.ip || null,
      userAgent: reqContext.userAgent || null,
      metadata: {
        email: user.email,
        failed_attempts: failedAttempts,
        locked_until: lockedUntil instanceof Date ? lockedUntil.toISOString() : lockedUntil,
      },
    }),

  logout: (user, req) =>
    auditEntity({ action: auditActions.LOGOUT, entity: 'auth', entityId: user?.id, performedBy: user, req }),
  passwordChanged: (user, req) =>
    auditEntity({ action: auditActions.PASSWORD_CHANGED, entity: 'auth', entityId: user.id, performedBy: user, req }),

  passwordResetRequest: async (email, req) => {
    const entreprise_id = await resolveEntrepriseIdFromEmail(email);
    return logAudit({
      action: auditActions.PASSWORD_RESET_REQUEST,
      entity: 'auth',
      entity_id: null,
      user_id: null,
      entreprise_id,
      ip: req?.ip || null,
      userAgent: req?.get?.('User-Agent') || null,
      metadata: { email },
    });
  },

  passwordResetSuccess: (user, req) =>
    auditEntity({ action: auditActions.PASSWORD_RESET_SUCCESS, entity: 'auth', entityId: user.id, performedBy: user, req }),

  twoFactorEnabled: (user, req) =>
    auditEntity({ action: auditActions.TWO_FACTOR_ENABLED, entity: 'utilisateur', entityId: user.id, performedBy: user, req }),

  twoFactorDisabled: (user, req) =>
    auditEntity({ action: auditActions.TWO_FACTOR_DISABLED, entity: 'utilisateur', entityId: user.id, performedBy: user, req }),

  twoFactorVerified: (user, req) =>
    auditEntity({ action: auditActions.TWO_FACTOR_VERIFIED, entity: 'utilisateur', entityId: user.id, performedBy: user, req }),
};

const auditCounter = {
  /**
   * Audit d'une modification de solde de compteur.
   * before/after = { jours_acquis, jours_pris, jours_reportes, jours_reserves }
   */
  updated: (compteur, before, after, performedBy, req) =>
    auditEntity({
      action: auditActions.COUNTER_UPDATED,
      entity: 'compteur_conges',
      entityId: compteur.id,
      performedBy,
      req,
      metadata: {
        utilisateur_cible_id: compteur.utilisateur_id,
        conge_type_id: compteur.conge_type_id,
        annee: compteur.annee,
        entreprise_id: compteur.entreprise_id,
        before,
        after,
      },
    }),

  /**
   * Audit de la suppression d'un compteur (snapshot des valeurs supprimées).
   */
  deleted: (compteur, performedBy, req) =>
    auditEntity({
      action: auditActions.COUNTER_DELETED,
      entity: 'compteur_conges',
      entityId: compteur.id,
      performedBy,
      req,
      metadata: {
        utilisateur_cible_id: compteur.utilisateur_id,
        conge_type_id: compteur.conge_type_id,
        annee: compteur.annee,
        entreprise_id: compteur.entreprise_id,
        snapshot: {
          jours_acquis:   Number(compteur.jours_acquis),
          jours_pris:     Number(compteur.jours_pris),
          jours_reportes: Number(compteur.jours_reportes),
          jours_reserves: Number(compteur.jours_reserves),
        },
      },
    }),
};

const auditImport = {
  usersSuccess: (performedBy, req, metadata = {}) =>
    auditEntity({ action: auditActions.IMPORT_USERS_SUCCESS, entity: 'import', entityId: null, performedBy, req, metadata }),
  usersFailed: (performedBy, req, metadata = {}) =>
    auditEntity({ action: auditActions.IMPORT_USERS_FAILED, entity: 'import', entityId: null, performedBy, req, metadata }),
  congesSuccess: (performedBy, req, metadata = {}) =>
    auditEntity({ action: auditActions.IMPORT_CONGES_SUCCESS, entity: 'import', entityId: null, performedBy, req, metadata }),
  congesFailed: (performedBy, req, metadata = {}) =>
    auditEntity({ action: auditActions.IMPORT_CONGES_FAILED, entity: 'import', entityId: null, performedBy, req, metadata }),

  inviteExpired: async (email, req) => {
    const entreprise_id = await resolveEntrepriseIdFromEmail(email);
    return logAudit({
      action: auditActions.INVITE_EXPIRED,
      entity: 'auth',
      entity_id: null,
      user_id: null,
      entreprise_id,
      ip: req?.ip || null,
      userAgent: req?.get?.('User-Agent') || null,
      metadata: { email },
    });
  },
};

const auditExport = {
  csvGenerated: (type, performedBy, req, metadata = {}) =>
    auditEntity({ action: auditActions.EXPORT_CSV_GENERATED, entity: 'export', entityId: null, performedBy, req, metadata: { type, ...metadata } }),
};

module.exports = {
  auditEntity,
  auditEntreprise,
  auditUser,
  auditConge,
  auditFerie,
  auditAuth,
  auditCounter,
  auditImport,
  auditExport,
};