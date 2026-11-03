'use strict';

const { AsyncLocalStorage } = require('async_hooks');
const { randomUUID, createHash } = require('crypto');
const { UniqueConstraintError } = require('sequelize');
const { Entreprise, Utilisateur, Conge, Absence, CongeActionRequest, NotificationDelivery } = require('../models');
const { resolvePreference, getServiceChannels } = require('./notificationPreferencesService');
const { getLeaveRules, canManagerAccessService } = require('./politiqueConges');
const logger = require('../utils/logger');
const { canReadComments, maskCommentFields } = require('./commentVisibilityService');
const { getNamedRoute, resolveManagerDelivery } = require('./managerCrossServicePolicy');

const storage = new AsyncLocalStorage();
const TEMPLATE_EVENTS = {
  'leave-new-request-manager': 'leave_created', 'leave-created-employee': 'leave_created',
  'leave-pending-reminder': 'leave_pending',
  'leave-manager-approved-admin': 'leave_manager_validated',
  'leave-manager-validated-employee': 'leave_manager_validated',
  'leave-approved-employee': 'leave_validated', 'leave-rejected-employee': 'leave_rejected',
  'leave-rejected-manager-info': 'leave_rejected',
  'leave-reminder': 'leave_reminder',
  'leave-reservation-employee': 'leave_reservation', 'leave-reservation-admin': 'leave_reservation',
  'leave-reservation-reminder': 'leave_reservation',
  'leave-reservation-activated': 'leave_activated',
  'leave-updated-before-approval': 'leave_modified', 'leave-updated-employee': 'leave_modified',
  'leave-updated-self-confirm': 'leave_modified',
  'leave-cancelled-by-employee': 'leave_cancelled', 'leave-cancelled-by-admin': 'leave_cancelled',
  'leave-cancelled-employee': 'leave_cancelled', 'leave-cancelled-self-confirm': 'leave_cancelled',
  'leave-action-approved': 'leave_action_decided', 'leave-action-rejected': 'leave_action_decided',
  'weekly-manager-summary': 'weekly_summary', 'monthly-report': 'monthly_report',
};
const TYPE_EVENTS = {
  conge_demande: 'leave_created', conge_cree: 'leave_created',
  conge_valide_manager: 'leave_manager_validated', conge_decision_manager: 'leave_manager_validated',
  conge_valide_final: 'leave_validated', conge_decision_admin: 'leave_validated',
  conge_refuse: 'leave_rejected', conge_decision_refus: 'leave_rejected',
  conge_modifie: 'leave_modified', conge_modifie_employe: 'leave_modified', conge_modifie_admin: 'leave_modified',
  conge_annule: 'leave_cancelled', conge_annule_employe: 'leave_cancelled',
  conge_annule_admin: 'leave_cancelled', conge_supprime_admin: 'leave_cancelled',
  conge_reservation_creee: 'leave_reservation', conge_rappel_reservation: 'leave_reservation',
  conge_reserve_active: 'leave_activated', conge_rappel_en_attente: 'leave_pending',
  conge_action_approved: 'leave_action_decided', conge_action_rejected: 'leave_action_decided',
};

function withContext(spec, fn) {
  if (storage.getStore()) return fn();
  return storage.run({ operationId: randomUUID(), seen: new Set(), ...spec }, fn);
}

function wrapWorkflow(fn, describe) {
  return (...args) => withContext(describe(...args), async () => {
    const ctx = storage.getStore();
    try {
      await loadContext(ctx);
    } catch (error) {
      ctx.preferenceError = error;
      logger.error('notification_context_error', { error: error.message, event: ctx.event });
    }
    return fn(...args);
  });
}

async function loadContext(ctx, transaction) {
  if (ctx.loaded) return;
  let employeeId = ctx.employeeId;
  if (ctx.entityId) {
    const model = ctx.kind === 'absence' ? Absence : ctx.kind === 'request' ? CongeActionRequest : Conge;
    const record = await model.findByPk(ctx.entityId, { transaction });
    employeeId ||= record?.utilisateur_id;
    ctx.entrepriseId ||= record?.entreprise_id;
    if (ctx.kind === 'absence' && record?.type_absence === 'maladie') {
      ctx.event = ctx.event.replace(/^absence_/, 'sickness_');
    }
  }
  const employee = employeeId ? await Utilisateur.findByPk(employeeId, { transaction }) : null;
  ctx.ownerId = employee?.id;
  ctx.service = employee?.service;
  ctx.entrepriseId ||= employee?.entreprise_id;
  ctx.company = ctx.entrepriseId ? await Entreprise.findByPk(ctx.entrepriseId, { transaction }) : null;
  ctx.preferences = ctx.company?.parametres?.notifications;
  ctx.loaded = true;
}

function resolveEvent(ctx, templateName, type) {
  if (ctx.kind === 'absence') return templateName === 'absence-notification' || type?.startsWith('absence_')
    || templateName === 'manager-event-information' ? ctx.event : null;
  if (templateName === 'manager-event-information') return ctx.event;
  if (type === 'conge_action_request' || /^leave-action-request-/.test(templateName || '')) return ctx.event;
  const event = TYPE_EVENTS[type] || TEMPLATE_EVENTS[templateName] || null;
  return ['leave_reservation', 'leave_activated'].includes(ctx.event) && event === 'leave_created' ? ctx.event : event;
}

async function prepareRecipient({ recipientId, email, templateName, type, mode, legacy = true, channel, transaction, resource }) {
  const ctx = storage.getStore();
  if (!ctx) return null;
  if (ctx.preferenceError) throw ctx.preferenceError;
  await loadContext(ctx, transaction);
  if (!ctx.preferences && !ctx.company?.politique_conges?.notification_routing) return null;
  const preferences = ctx.preferences || {};
  const recipient = recipientId
    ? await Utilisateur.findByPk(recipientId, { transaction })
    : await Utilisateur.findOne({ where: { email }, transaction });
  if (!recipient || recipient.entreprise_id !== ctx.entrepriseId) {
    throw new Error('Destinataire de notification extérieur à l’entreprise ou introuvable.');
  }
  const event = resolveEvent(ctx, templateName, type);
  if (!event) return null;
  const category = event.startsWith('sickness_') ? 'maladie' : event.startsWith('absence_') ? 'absence_exceptionnelle' : 'conges';
  const rules = getLeaveRules(ctx.company);
  const route = recipient.id !== ctx.ownerId ? getNamedRoute(rules, ctx.service, category, recipient.id) : null;
  const effectiveMode = ctx.kind === 'absence' || recipient.id === ctx.ownerId || route?.mode === 'information' ? 'information' : mode || 'information';
  const commentsAllowed = canReadComments(ctx.preferences, recipient, category, ctx.ownerId, rules, ctx.service);
  const canView = recipient.id === ctx.ownerId || recipient.role !== 'manager'
    || resolveManagerDelivery({ rules, manager: recipient, targetService: ctx.service, category }).canView;
  const scopePrefix = recipient.role === 'manager' ? 'manager' : recipient.role === 'admin_entreprise' ? 'admin' : null;
  if (!preferences.roles?.[recipient.role]?.[event]?.[effectiveMode]
    && !preferences.roles?.[recipient.role]?.[event]?.workflow
    && !getServiceChannels(preferences, ctx.service, recipient.role, event, effectiveMode)
    && !getServiceChannels(preferences, ctx.service, recipient.role, event, 'workflow')
    && !route
    && commentsAllowed
    && !Object.hasOwn(preferences.report_recipients || {}, event)
    && !(scopePrefix && (preferences[`${scopePrefix}_scope`] || preferences[`${scopePrefix}_event_scopes`]?.[event]))) {
    return null;
  }
  const enabled = resolvePreference({
    preferences, rules, recipient, event, mode: effectiveMode,
    service: ctx.service, ownerId: ctx.ownerId, legacy, channel,
  });
  const resourceId = ctx.entityId || String(resource || '').match(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/i)?.[0] || ctx.ownerId || ctx.entrepriseId;
  return { ctx, recipient, event, mode: effectiveMode, enabled, resource: resourceId, commentsAllowed: commentsAllowed && canView,
    explicitComments: route?.comments === true && commentsAllowed && canView };
}

async function prepareRecipientSafely(parameters) {
  try {
    return await prepareRecipient(parameters);
  } catch (error) {
    logger.error('notification_preferences_error', {
      error: error.message, recipientId: parameters.recipientId, channel: parameters.channel,
    });
    return { enabled: false, error };
  }
}

async function sendConfiguredEmail({ to, subject, templateName, data = {} }, send) {
  if (Array.isArray(to)) {
    const results = [];
    for (const address of [...new Set(to)]) {
      results.push(await sendConfiguredEmail({ to: address, subject, templateName, data }, send));
    }
    return results;
  }
  const prepared = await prepareRecipientSafely({
    email: to, templateName, mode: data.notification_delivery?.canAct === false ? 'information' : data.notification_mode,
    legacy: data.notification_delivery?.email !== false, channel: 'email',
    resource: data.notification_resource || data.action_url,
  });
  if (!prepared) return send({ to, subject, templateName, data });
  if (!prepared.enabled) return undefined;
  const { emailNotifications } = await require('./systemSettingsService').getSettings();
  if (!emailNotifications) return undefined;
  const { ctx, recipient, event, mode } = prepared;
  const key = createHash('sha256').update(`${ctx.operationId}:${prepared.resource}:${recipient.id}:${event}:email`).digest('hex');
  let claim;
  try {
    claim = await NotificationDelivery.create({
      key, entreprise_id: ctx.entrepriseId, utilisateur_id: recipient.id, event,
    });
  } catch (error) {
    if (!(error instanceof UniqueConstraintError)) throw error;
    return undefined;
  }
  try {
    const result = await send({
      to, subject, templateName,
      data: {
        ...(prepared.commentsAllowed ? data : maskCommentFields(data)), notification_mode: mode, destinataire_prenom: recipient.prenom || 'Collaborateur',
        entreprise_id: ctx.entrepriseId, utilisateur_id: recipient.id,
        destinataire_role: recipient.role,
        notification_owner: recipient.id === ctx.ownerId,
        notification_comments_allowed: prepared.explicitComments,
      },
    });
    await claim.update({ status: 'sent' });
    await notifyDelegate(prepared, delegate => sendConfiguredEmail({
      to: delegate.email, subject, templateName,
      data: { ...data, notification_mode: mode },
    }, send));
    return result;
  } catch (error) {
    await claim.update({ status: 'failed' });
    throw error;
  }

}

function setNotificationEvent(event) {
  const ctx = storage.getStore();
  if (ctx) ctx.event = event;
}

async function getAuthorizedDelegate(prepared) {
  const { ctx, recipient, mode } = prepared;
  if (mode !== 'action' || !recipient.delegue_id || ctx.kind !== 'leave') return null;
  const delegate = await Utilisateur.findByPk(recipient.delegue_id);
  if (!delegate || delegate.id === ctx.ownerId || delegate.entreprise_id !== ctx.entrepriseId
    || delegate.statut !== 'actif') return null;
  // Only notify a delegate whose actual role already passes the existing HTTP/action guards.
  if (recipient.role === 'manager' && delegate.role === 'manager'
    && canManagerAccessService(delegate, ctx.service, getLeaveRules(ctx.company), 'validate')) return delegate;
  if (recipient.role === 'admin_entreprise' && delegate.role === 'admin_entreprise') return delegate;
  return null;
}

async function notifyDelegate(prepared, send) {
  try {
    const delegate = await getAuthorizedDelegate(prepared);
    if (delegate) await send(delegate);
  } catch (error) {
    logger.error('notification_delegate_error', { error: error.message, recipientId: prepared.recipient.id });
  }
}

module.exports = { withContext, wrapWorkflow, prepareRecipient, prepareRecipientSafely, sendConfiguredEmail, notifyDelegate, setNotificationEvent };
