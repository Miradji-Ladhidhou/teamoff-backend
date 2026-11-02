'use strict';

const { Entreprise, Utilisateur, sequelize } = require('../models');
const { normalizeNotificationSettings, getLeaveRules, getEffectiveLeaveRules } = require('./politiqueConges');
const { normalizeManagerCrossServicePolicy, getNamedRoute, resolveManagerDelivery } = require('./managerCrossServicePolicy');
const { COMMENT_CATEGORIES, COMMENT_ROLES } = require('./commentVisibilityService');

const ROLES = ['super_admin', 'admin_entreprise', 'manager', 'employe', 'apprenti'];
const EVENT_RECIPIENT_ROLES = {
  leave_pending: ['admin_entreprise', 'manager'],
  weekly_summary: ['admin_entreprise', 'manager'],
  monthly_report: ['admin_entreprise'],
};
function getEventGroup(event) {
  if (['leave_created', 'leave_reservation', 'leave_activated', 'absence_created', 'sickness_created'].includes(event)) return 'creation';
  if (['leave_cancelled', 'leave_cancel_requested', 'absence_cancelled', 'sickness_cancelled'].includes(event)) return 'suppression';
  return 'modification';
}
const EVENTS = [
  ['leave_created', 'Nouvelle demande de congé', true],
  ['leave_pending', 'Demande en attente de validation', true],
  ['leave_manager_validated', 'Validation par le manager', true],
  ['leave_validated', 'Validation finale', false],
  ['leave_rejected', 'Refus d’une demande', false],
  ['leave_modified', 'Modification d’une demande', true],
  ['leave_cancelled', 'Annulation d’une demande', false],
  ['leave_modify_requested', 'Demande de modification d’un congé validé', true],
  ['leave_cancel_requested', 'Demande d’annulation d’un congé validé', true],
  ['leave_action_decided', 'Décision sur une modification ou annulation', false],
  ['leave_reservation', 'Réservation de congé et rappel', true],
  ['leave_activated', 'Activation d’une réservation', false],
  ['leave_reminder', 'Rappel avant départ', false],
  ['absence_created', 'Déclaration d’absence exceptionnelle', false],
  ['absence_modified', 'Modification d’absence exceptionnelle', false],
  ['absence_cancelled', 'Suppression d’absence exceptionnelle', false],
  ['sickness_created', 'Déclaration d’arrêt maladie', false],
  ['sickness_modified', 'Modification d’arrêt maladie', false],
  ['sickness_cancelled', 'Suppression d’arrêt maladie', false],
  ['weekly_summary', 'Récapitulatif hebdomadaire', false],
  ['monthly_report', 'Rapport mensuel', false],
].map(([id, label, requiresChannel]) => ({
  id, label, requiresChannel, group: getEventGroup(id),
  roles: EVENT_RECIPIENT_ROLES[id] || ROLES.filter(role => role !== 'super_admin'),
  family: id.startsWith('leave_') ? 'conges' : id.startsWith('absence_') ? 'absence_exceptionnelle'
    : id.startsWith('sickness_') ? 'maladie' : 'reports',
}));

const invalid = message => Object.assign(new Error(message), { status: 400 });
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function validateScope(scope, services, users) {
  if (!isObject(scope) || !['company', 'services', 'users'].includes(scope.mode)) {
    throw invalid('Périmètre administrateur invalide.');
  }
  if (Object.keys(scope).some(key => !['mode', 'services', 'user_ids'].includes(key))) {
    throw invalid('Champ de périmètre inconnu.');
  }
  for (const [field, allowed] of [['services', services], ['user_ids', users]]) {
    if (scope[field] !== undefined && (!Array.isArray(scope[field])
      || scope[field].some(value => typeof value !== 'string' || !allowed.includes(value)))) {
      throw invalid('Le périmètre doit appartenir à cette entreprise.');
    }
  }
  const selected = scope.mode === 'services' ? scope.services : scope.user_ids;
  if (scope.mode !== 'company' && (!Array.isArray(selected) || scope.mode === 'users' && !selected.length)) {
    throw invalid('Sélectionnez au moins un service ou administrateur.');
  }
}

function remapServicePreferences(preferences, currentName, nextName) {
  const result = { ...preferences };
  if (preferences.service_roles && Object.hasOwn(preferences.service_roles, currentName)) {
    result.service_roles = { ...preferences.service_roles };
    if (nextName) result.service_roles[nextName] = result.service_roles[currentName];
    delete result.service_roles[currentName];
  }
  const remapScope = scope => scope?.mode === 'services' ? {
    ...scope, services: [...new Set(scope.services.flatMap(service => service !== currentName ? [service] : nextName ? [nextName] : []))],
  } : scope;
  for (const prefix of ['admin', 'manager']) {
    if (preferences[`${prefix}_scope`]) result[`${prefix}_scope`] = remapScope(preferences[`${prefix}_scope`]);
    if (preferences[`${prefix}_event_scopes`]) result[`${prefix}_event_scopes`] = Object.fromEntries(
      Object.entries(preferences[`${prefix}_event_scopes`]).map(([event, scope]) => [event, remapScope(scope)]));
  }
  return result;
}

function validatePreferences(preferences, services, adminIds, managerIds = []) {
  if (!isObject(preferences) || preferences.version !== 1
    || Object.keys(preferences).some(key => !['version', 'roles', 'service_roles', 'comment_reading', 'admin_scope', 'admin_event_scopes', 'manager_scope', 'manager_event_scopes'].includes(key))) {
    throw invalid('Configuration des notifications invalide.');
  }
  if (preferences.comment_reading !== undefined) {
    if (!isObject(preferences.comment_reading)) throw invalid('Droits de lecture des commentaires invalides.');
    for (const [role, categories] of Object.entries(preferences.comment_reading)) {
      if (!COMMENT_ROLES.includes(role) || !isObject(categories)
        || Object.entries(categories).some(([category, allowed]) => !COMMENT_CATEGORIES.includes(category) || typeof allowed !== 'boolean')) {
        throw invalid('Droits de lecture des commentaires invalides.');
      }
    }
  }
  if (preferences.admin_scope !== undefined) validateScope(preferences.admin_scope, services, adminIds);
  if (preferences.admin_event_scopes !== undefined) {
    if (!isObject(preferences.admin_event_scopes)) throw invalid('Périmètres événementiels invalides.');
    for (const [event, scope] of Object.entries(preferences.admin_event_scopes)) {
      if (!EVENTS.some(item => item.id === event)) throw invalid('Événement inconnu.');
      validateScope(scope, services, adminIds);
    }
  }
  if (preferences.manager_scope !== undefined) validateScope(preferences.manager_scope, services, managerIds);
  if (preferences.manager_event_scopes !== undefined) {
    if (!isObject(preferences.manager_event_scopes)) throw invalid('Périmètres manager invalides.');
    for (const [event, scope] of Object.entries(preferences.manager_event_scopes)) {
      if (!EVENTS.some(item => item.id === event && item.roles.includes('manager'))) throw invalid('Événement manager invalide.');
      validateScope(scope, services, managerIds);
    }
  }
  if (preferences.service_roles !== undefined) {
    if (!isObject(preferences.service_roles)) throw invalid('Configuration par service invalide.');
    for (const [service, roles] of Object.entries(preferences.service_roles)) {
      if (!services.includes(service)) throw invalid('Le service doit appartenir à cette entreprise.');
      if (!isObject(roles)) throw invalid('Configuration des rôles du service invalide.');
      for (const events of Object.values(roles)) {
        if (isObject(events) && Object.keys(events).some(event => ['weekly_summary', 'monthly_report'].includes(event))) {
          throw invalid('Les rapports d’équipe se configurent au niveau de l’entreprise.');
        }
      }
      validatePreferences({ version: 1, roles }, services, adminIds, managerIds);
      for (const [role, events] of Object.entries(roles)) {
        if (!['manager', 'admin_entreprise'].includes(role)) continue;
        for (const event of Object.keys(events)) {
          if (!EVENTS.find(item => item.id === event)?.requiresChannel) continue;
          const enabled = channel => resolvePreference({
            preferences, recipient: { role, id: 'validator' }, ownerId: 'validator',
            service, event, mode: 'action', channel,
          });
          if (!enabled('email') && !enabled('in_app')) throw invalid('Au moins un canal est requis pour les demandes à traiter de ce service.');
        }
      }
    }
  }
  if (preferences.roles === undefined) return;
  if (!isObject(preferences.roles)) throw invalid('Configuration des rôles invalide.');
  for (const [role, events] of Object.entries(preferences.roles)) {
    if (!ROLES.includes(role) || !isObject(events)) throw invalid('Rôle invalide.');
    for (const [event, modes] of Object.entries(events)) {
      const definition = EVENTS.find(item => item.id === event);
      if (!definition || !isObject(modes)) throw invalid('Événement invalide.');
      for (const [mode, channels] of Object.entries(modes)) {
        const workflow = mode === 'workflow';
        if (!['action', 'information', 'workflow'].includes(mode) || !isObject(channels)
          || Object.keys(channels).some(key => !['email', 'in_app'].includes(key))
          || (workflow ? !Object.keys(channels).length || Object.values(channels).some(value => typeof value !== 'boolean')
            : typeof channels.email !== 'boolean' || typeof channels.in_app !== 'boolean')) {
          throw invalid('Les deux canaux doivent être des booléens.');
        }
        if (mode === 'action' && /^(absence|sickness)_/.test(event)) {
          throw invalid('Les absences et arrêts maladie sont uniquement informatifs.');
        }
      }
      if (definition.requiresChannel && (modes.action || ['manager', 'admin_entreprise'].includes(role))
        && (modes.workflow?.email ?? modes.action?.email) === false
        && (modes.workflow?.in_app ?? modes.action?.in_app) === false) {
        throw invalid(`Au moins un canal est requis pour « ${definition.label} ».`);
      }
    }
  }
}

function resolvePreference({ preferences, recipient, event, mode = 'information', service, ownerId, legacy = true, channel, rules }) {
  const category = EVENTS.find(item => item.id === event)?.family;
  const route = recipient.id !== ownerId ? getNamedRoute(rules, service, category, recipient.id) : null;
  if (route?.events?.[getEventGroup(event)] === false) return false;
  if (route?.mode) return route.mode !== 'none' && route[channel] === true;
  if (!preferences || !event) return legacy;
  if (['admin_entreprise', 'manager'].includes(recipient.role) && recipient.id !== ownerId) {
    const prefix = recipient.role === 'manager' ? 'manager' : 'admin';
    const scope = preferences[`${prefix}_event_scopes`]?.[event] || preferences[`${prefix}_scope`];
    if (scope?.mode === 'services' && !['weekly_summary', 'monthly_report'].includes(event) && !scope.services.includes(service)) return false;
    if (scope?.mode === 'users' && !scope.user_ids.includes(recipient.id)) return false;
  }
  if (['employe', 'apprenti'].includes(recipient.role) && recipient.id !== ownerId) return false;
  return getServiceChannels(preferences, service, recipient.role, event, 'workflow')?.[channel]
    ?? getServiceChannels(preferences, service, recipient.role, event, mode)?.[channel]
    ?? preferences.roles?.[recipient.role]?.[event]?.workflow?.[channel]
    ?? preferences.roles?.[recipient.role]?.[event]?.[mode]?.[channel] ?? legacy;
}

function getServiceChannels(preferences, service, role, event, mode) {
  const services = preferences?.service_roles;
  if (!service || !services || !Object.hasOwn(services, service)) return undefined;
  return services[service]?.[role]?.[event]?.[mode];
}

function filterAdministrativeRecords(preferences, recipient, event, records) {
  if (!['admin_entreprise', 'manager'].includes(recipient.role)) return records;
  const prefix = recipient.role === 'manager' ? 'manager' : 'admin';
  const scope = preferences?.[`${prefix}_event_scopes`]?.[event] || preferences?.[`${prefix}_scope`];
  return scope?.mode === 'services' ? records.filter(record => scope.services.includes(record.utilisateur?.service)) : records;
}

async function getConfiguration(entrepriseId, transaction = null) {
  const company = await Entreprise.findByPk(entrepriseId, { transaction });
  if (!company) throw Object.assign(new Error('Entreprise introuvable.'), { status: 404 });
  const users = await Utilisateur.findAll({
    where: { entreprise_id: entrepriseId, statut: 'actif' },
    attributes: ['id', 'role', 'service', 'prenom', 'nom'], transaction,
  });
  const services = [...new Set([
    ...Object.keys(company.politique_conges?.service_policies || {}),
    ...users.map(user => user.service).filter(Boolean),
  ])].sort();
  const rules = getLeaveRules(company);
  return {
    preferences: company.parametres?.notifications || { version: 1, roles: {} },
    legacy: normalizeNotificationSettings(company.politique_conges?.notification_settings),
    manager_services: Object.fromEntries(Object.entries(company.politique_conges?.service_policies || {})
      .map(([name, policy]) => [name, normalizeManagerCrossServicePolicy(policy)])),
    services,
    administrators: users.filter(user => user.role === 'admin_entreprise'),
    managers: users.filter(user => user.role === 'manager'),
    routing: rules.notification_routing,
    recipient_defaults: Object.fromEntries(services.map(service => [service, Object.fromEntries(
      ['conges', 'absence_exceptionnelle', 'maladie'].map(category => [category, Object.fromEntries(
        users.filter(user => ['manager', 'admin_entreprise'].includes(user.role)).map(user => {
          const delivery = user.role === 'manager' ? resolveManagerDelivery({ rules, manager: user, targetService: service, category })
            : { email: true, in_app: true, canAct: true, canView: true };
          return [user.id, delivery];
        }),
      )]),
    )])),
    default_workflow: rules.approval_workflow,
    service_workflows: Object.fromEntries(services.map(service => [
      service, getEffectiveLeaveRules(rules, service).approval_workflow,
    ])),
    roles: ROLES, events: EVENTS,
  };
}

async function updateConfiguration(entrepriseId, body, userId) {
  if (!isObject(body) || Object.keys(body).some(key => !['preferences', 'legacy', 'manager_services', 'routing'].includes(key))) {
    throw invalid('Paramètres des notifications invalides.');
  }
  return sequelize.transaction(async transaction => {
    const company = await Entreprise.findByPk(entrepriseId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!company) throw Object.assign(new Error('Entreprise introuvable.'), { status: 404 });
    const current = await getConfiguration(entrepriseId, transaction);
    if (body.preferences !== undefined) {
      validatePreferences(body.preferences, current.services, current.administrators.map(admin => admin.id), current.managers.map(manager => manager.id));
      company.parametres = { ...company.parametres, notifications: body.preferences };
    }
    const policy = { ...company.politique_conges };
    if (body.routing !== undefined) {
      if (!isObject(body.routing)) throw invalid('Affectations des responsables invalides.');
      const users = [...current.managers, ...current.administrators];
      const routing = { ...policy.notification_routing };
      for (const [service, categories] of Object.entries(body.routing)) {
        if (!current.services.includes(service) || !isObject(categories)) throw invalid('Service des affectations invalide.');
        routing[service] = { ...routing[service] };
        for (const [category, recipients] of Object.entries(categories)) {
          if (!['conges', 'absence_exceptionnelle', 'maladie'].includes(category) || !isObject(recipients)) throw invalid('Catégorie des affectations invalide.');
          routing[service][category] = { ...routing[service][category] };
          for (const [id, route] of Object.entries(recipients)) {
            const recipient = users.find(user => user.id === id);
            if (!recipient) throw invalid('Sélectionnez un responsable actif de cette entreprise.');
            if (route === null) {
              delete routing[service][category][id];
              continue;
            }
            if (!isObject(route) || Object.keys(route).some(key => !['mode', 'email', 'in_app', 'events', 'comments'].includes(key))
              || (route.mode === undefined
                ? route.email !== undefined || route.in_app !== undefined || route.comments === undefined && route.events === undefined
                : !['none', 'information', 'workflow'].includes(route.mode)
                  || typeof route.email !== 'boolean' || typeof route.in_app !== 'boolean')
              || category !== 'conges' && route.mode === 'workflow') throw invalid('Choix du responsable invalide.');
            if (route.mode === 'workflow' && !route.email && !route.in_app) throw invalid('Gardez au moins un canal pour le responsable qui traite les demandes.');
            if (route.comments !== undefined && typeof route.comments !== 'boolean') throw invalid('Le droit de lecture des commentaires doit être un booléen.');
            if (route.events !== undefined && (!isObject(route.events) || Object.entries(route.events).some(([group, enabled]) =>
              !['creation', 'modification', 'suppression'].includes(group) || typeof enabled !== 'boolean'))) {
              throw invalid('Groupes de notifications invalides.');
            }
            routing[service][category][id] = route;
          }
        }
      }
      policy.notification_routing = routing;
    }
    if (body.legacy !== undefined) {
      if (!isObject(body.legacy) || Object.entries(body.legacy).some(([key, value]) =>
        !['on_create', 'on_validate', 'on_reject'].includes(key) || typeof value !== 'boolean')) {
        throw invalid('Options historiques invalides.');
      }
      policy.notification_settings = { ...policy.notification_settings, ...body.legacy };
    }
    if (body.manager_services !== undefined) {
      if (!isObject(body.manager_services)) throw invalid('Canaux interservices invalides.');
      policy.service_policies = { ...policy.service_policies };
      for (const [service, categories] of Object.entries(body.manager_services)) {
        if (!policy.service_policies[service] || !isObject(categories)) throw invalid('Service inconnu.');
        const crossService = normalizeManagerCrossServicePolicy(policy.service_policies[service]);
        const explicit = { ...policy.service_policies[service].manager_cross_service };
        let changed = false;
        for (const [category, channels] of Object.entries(categories)) {
          if (!crossService[category] || !isObject(channels) || Object.entries(channels).some(([key, value]) =>
            !['email', 'in_app'].includes(key) || typeof value !== 'boolean')) throw invalid('Canal interservices invalide.');
          if (Object.entries(channels).some(([channel, value]) => crossService[category][channel] !== value)) {
            explicit[category] = { ...crossService[category], ...channels };
            changed = true;
          }
        }
        if (changed) policy.service_policies[service] = { ...policy.service_policies[service], manager_cross_service: explicit };
      }
    }
    company.politique_conges = policy;
    await company.save({ transaction, userId });
    return getConfiguration(entrepriseId, transaction);
  });
}

module.exports = { ROLES, EVENTS, validatePreferences, resolvePreference, getServiceChannels, getConfiguration, updateConfiguration, filterAdministrativeRecords, remapServicePreferences };
