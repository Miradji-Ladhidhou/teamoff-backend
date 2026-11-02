'use strict';

jest.mock('../../src/models', () => ({ Entreprise: {}, Utilisateur: {}, sequelize: {} }));
const { resolveManagerDelivery, getManagerUserWhere } = require('../../src/services/managerCrossServicePolicy');
const { canManagerAccessService, getLeaveRules } = require('../../src/services/politiqueConges');
const { resolvePreference } = require('../../src/services/notificationPreferencesService');
const manager = { id: 'manager-a', role: 'manager', service: 'RH' };
const rules = getLeaveRules({ politique_conges: { notification_routing: {
  Finance: { conges: { 'manager-a': { mode: 'workflow', email: false, in_app: true } } },
  Support: { conges: { 'manager-a': { mode: 'information', email: true, in_app: true } } },
} } });

test('une autorisation nominative est directionnelle et donne consultation/validation seulement au bon service', () => {
  expect(canManagerAccessService(manager, 'Finance', rules, 'view')).toBe(true);
  expect(canManagerAccessService(manager, 'Finance', rules, 'validate')).toBe(true);
  expect(canManagerAccessService(manager, 'Finance', rules, 'modify')).toBe(false);
  expect(canManagerAccessService(manager, 'Support', rules, 'view')).toBe(false);
  expect(canManagerAccessService({ ...manager, id: 'manager-b' }, 'Finance', rules, 'validate')).toBe(false);
  expect(getManagerUserWhere(rules, manager)).toBeDefined();
});

test('le même responsable reçoit une action à son étape et une information après son étape', () => {
  const resolve = actionRequired => resolveManagerDelivery({ rules, manager, targetService: 'Finance', actionRequired });
  expect(resolve(true)).toMatchObject({ canAct: true, canView: true, email: false, in_app: true, mode: 'action' });
  expect(resolve(false).mode).toBe('information');
  expect(resolveManagerDelivery({ rules, manager, targetService: 'Support', actionRequired: true }))
    .toMatchObject({ canAct: false, canView: false, mode: 'information' });
});

test.each(['action', 'information'])('le routage nommé prime sur les anciennes restrictions pour %s sans toucher au propriétaire', mode => {
  const preferences = { manager_scope: { mode: 'users', user_ids: ['other'] } };
  const resolve = (channel, ownerId = 'owner') => resolvePreference({
    preferences, rules, recipient: manager, event: 'leave_created', service: 'Finance', mode, channel, ownerId,
  });
  expect(resolve('email')).toBe(false);
  expect(resolve('in_app')).toBe(true);
  expect(resolve('email', manager.id)).toBe(true);
});

test('informer ou ne pas prévenir ne retire pas les droits métier antérieurs', () => {
  const legacy = { ...rules, service_policies: { RH: { manager_can_validate_all_services: true } } };
  expect(canManagerAccessService(manager, 'Support', legacy, 'validate')).toBe(true);
});

test.each([
  ['leave_created', 'creation'], ['leave_reservation', 'creation'], ['leave_activated', 'creation'],
  ['leave_pending', 'modification'], ['leave_manager_validated', 'modification'], ['leave_validated', 'modification'],
  ['leave_rejected', 'modification'], ['leave_modified', 'modification'], ['leave_modify_requested', 'modification'],
  ['leave_action_decided', 'modification'], ['leave_cancelled', 'suppression'], ['leave_cancel_requested', 'suppression'],
  ['absence_created', 'creation'], ['absence_modified', 'modification'], ['absence_cancelled', 'suppression'],
  ['sickness_created', 'creation'], ['sickness_modified', 'modification'], ['sickness_cancelled', 'suppression'],
])('%s est filtré uniquement par sa colonne %s sans retirer le droit de valider', (event, group) => {
  const category = event.startsWith('absence_') ? 'absence_exceptionnelle' : event.startsWith('sickness_') ? 'maladie' : 'conges';
  const routing = { notification_routing: { Finance: { [category]: { [manager.id]: {
    mode: 'workflow', email: true, in_app: true, events: { [group]: false },
  } } } } };
  for (const channel of ['email', 'in_app']) expect(resolvePreference({
    rules: routing, recipient: manager, event, service: 'Finance', ownerId: 'owner', channel,
  })).toBe(false);
  if (category === 'conges') expect(canManagerAccessService(manager, 'Finance', routing, 'validate')).toBe(true);
});

test('modifier seulement Commentaire ou une colonne ne choisit aucun canal et ne crée aucun droit interservice', () => {
  const routing = { notification_routing: { Finance: { conges: { [manager.id]: { comments: true, events: { suppression: false } } } } } };
  expect(resolveManagerDelivery({ rules: routing, manager, targetService: 'Finance' })).toMatchObject({
    email: false, in_app: false, canAct: false, canView: false,
  });
  expect(resolvePreference({ rules: routing, preferences: { manager_scope: { mode: 'users', user_ids: ['other'] } },
    recipient: manager, event: 'leave_created', service: 'Finance', ownerId: 'owner', channel: 'email' })).toBe(false);
  expect(resolvePreference({ rules: routing, recipient: manager, event: 'leave_created', service: 'Finance',
    ownerId: 'owner', channel: 'email', legacy: false })).toBe(false);
});
