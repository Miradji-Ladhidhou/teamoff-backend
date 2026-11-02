'use strict';

jest.mock('../../src/models', () => ({ Entreprise: {}, Utilisateur: {}, sequelize: {} }));
const { EVENTS, resolvePreference, remapServicePreferences, validatePreferences } = require('../../src/services/notificationPreferencesService');
const { resolveManagerDelivery } = require('../../src/services/managerCrossServicePolicy');

const CHANNELS = [[false, false], [false, true], [true, false], [true, true]];

test.each(EVENTS)('$id : canaux indépendants, héritage par rôle/service et confirmations personnelles', event => {
  for (const role of event.roles) {
    for (const [email, in_app] of CHANNELS) {
      const recipient = { id: 'recipient', role, service: 'RH' };
      const preferences = { roles: { [role]: { [event.id]: { workflow: { email, in_app } } } } };
      for (const channel of ['email', 'in_app']) {
        const parameters = { preferences, recipient, event: event.id, channel, service: 'RH', ownerId: recipient.id };
        expect(resolvePreference(parameters)).toBe(channel === 'email' ? email : in_app);
        const local = { ...preferences, service_roles: { RH: { [role]: { [event.id]: { workflow: { [channel]: !preferences.roles[role][event.id].workflow[channel] } } } } } };
        expect(resolvePreference({ ...parameters, preferences: local })).toBe(!preferences.roles[role][event.id].workflow[channel]);
        expect(resolvePreference({ ...parameters, service: 'Finance' })).toBe(preferences.roles[role][event.id].workflow[channel]);
        if (['employe', 'apprenti'].includes(role)) expect(resolvePreference({ ...parameters, ownerId: 'someone-else' })).toBe(false);
      }
    }
  }
});

test.each(EVENTS.filter(event => event.family !== 'reports'))('$id : chaque mode et groupe nominatif filtre les deux canaux sans affecter une autre personne ou un autre service', event => {
  for (const role of ['manager', 'admin_entreprise']) {
    const recipient = { id: 'recipient', role, service: 'Finance' };
    for (const mode of ['none', 'information', 'workflow']) {
      for (const [email, in_app] of CHANNELS) {
        for (const enabled of [false, true]) {
          const route = { mode, email, in_app, events: { [event.group]: enabled } };
          const rules = { notification_routing: { RH: { [event.family]: { [recipient.id]: route } } } };
          for (const channel of ['email', 'in_app']) {
            const parameters = { rules, recipient, event: event.id, channel, service: 'RH', ownerId: 'owner', legacy: false };
            expect(resolvePreference(parameters)).toBe(mode !== 'none' && enabled && route[channel]);
            expect(resolvePreference({ ...parameters, service: 'Support' })).toBe(false);
            expect(resolvePreference({ ...parameters, recipient: { ...recipient, id: 'colleague' } })).toBe(false);
            expect(resolvePreference({ ...parameters, ownerId: recipient.id, legacy: true })).toBe(true);
          }
        }
      }
    }
  }
});

test.each(['manager', 'manager_only', 'manager_admin', 'admin_only', 'auto'])('circuit %s : le type suit l’étape, pas la seule activation du canal', workflow => {
  for (const mode of ['none', 'information', 'workflow']) {
    const rules = { notification_routing: { RH: { conges: { recipient: { mode, email: true, in_app: true } } } } };
    const manager = { id: 'recipient', role: 'manager', service: 'Finance' };
    const actionRequired = ['manager', 'manager_only', 'manager_admin'].includes(workflow);
    const delivery = resolveManagerDelivery({ rules, manager, targetService: 'RH', actionRequired });
    expect(delivery.mode).toBe(mode === 'workflow' && actionRequired ? 'action' : 'information');
    expect(delivery.email).toBe(mode !== 'none');
    expect(delivery.in_app).toBe(mode !== 'none');
    expect(resolveManagerDelivery({ rules, manager, targetService: 'RH', actionRequired: false }).mode).toBe('information');
  }
});

test('renommage et suppression traitent tous les filtres sans muter les données ni élargir les sélections', () => {
  const original = {
    version: 1, roles: {},
    service_roles: { RH: { manager: { leave_created: { workflow: { email: false, in_app: true } } } } },
  };
  for (const role of ['admin', 'manager']) {
    original[`${role}_scope`] = { mode: 'services', services: ['RH'] };
    original[`${role}_event_scopes`] = { leave_created: { mode: 'services', services: ['Finance', 'RH'] } };
  }
  const copy = JSON.parse(JSON.stringify(original));
  const renamed = remapServicePreferences(original, 'RH', 'Support');
  expect(renamed.service_roles.Support).toEqual(original.service_roles.RH);
  const deleted = remapServicePreferences(renamed, 'Support');
  expect(deleted.service_roles).toEqual({});
  for (const role of ['admin', 'manager']) {
    expect(renamed[`${role}_scope`].services).toEqual(['Support']);
    expect(deleted[`${role}_scope`]).toEqual({ mode: 'services', services: [] });
    expect(deleted[`${role}_event_scopes`].leave_created.services).toEqual(['Finance']);
  }
  expect(() => validatePreferences(deleted, ['Finance'], [], [])).not.toThrow();
  expect(original).toEqual(copy);
});
