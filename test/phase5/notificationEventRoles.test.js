'use strict';

jest.mock('../../src/models', () => ({
  Entreprise: { findByPk: jest.fn() },
  Utilisateur: { findAll: jest.fn() },
  sequelize: {},
}));
const { Entreprise, Utilisateur } = require('../../src/models');
const { EVENTS, getConfiguration, validatePreferences, resolvePreference, filterAdministrativeRecords } = require('../../src/services/notificationPreferencesService');

test('les choix workflow partiels gardent les différences historiques sur le canal non modifié', () => {
  const preferences = { version: 1, roles: { manager: { leave_created: {
    action: { email: true, in_app: true }, information: { email: false, in_app: false }, workflow: { email: false },
  } } } };
  expect(() => validatePreferences(preferences, [], [])).not.toThrow();
  for (const mode of ['action', 'information']) {
    const resolve = channel => resolvePreference({ preferences, recipient: { id: 'manager', role: 'manager' },
      event: 'leave_created', mode, channel, ownerId: 'owner' });
    expect(resolve('email')).toBe(false);
    expect(resolve('in_app')).toBe(mode === 'action');
  }
  preferences.roles.manager.leave_created.workflow.in_app = false;
  expect(() => validatePreferences(preferences, [], [])).toThrow(/Au moins/);
});

test('un choix service garde la priorité et ne peut pas couper tous les canaux action par combinaison avec le commun', () => {
  const preferences = { version: 1, roles: { manager: { leave_created: { workflow: { email: false } } } },
    service_roles: { RH: { manager: { leave_created: { workflow: { in_app: false } } } } } };
  expect(() => validatePreferences(preferences, ['RH'], [])).toThrow(/Au moins/);
  preferences.service_roles.RH.manager.leave_created.workflow.email = true;
  expect(() => validatePreferences(preferences, ['RH'], [])).not.toThrow();
});

test('le canal workflow actif reste prioritaire sur une ancienne exception action désactivée', () => {
  const preferences = { version: 1, roles: { manager: { leave_created: {
    action: { email: false, in_app: false }, workflow: { email: true },
  } } } };
  expect(() => validatePreferences(preferences, [], [])).not.toThrow();
  delete preferences.roles.manager.leave_created.workflow;
  expect(() => validatePreferences(preferences, [], [])).toThrow(/Au moins/);
});

test.each([
  { manager: { conges: false, maladie: true } },
  { employe: { absence_exceptionnelle: false } },
])('les droits de lecture sont valides indépendamment des canaux : %j', comment_reading => {
  expect(() => validatePreferences({ version: 1, comment_reading }, [], [])).not.toThrow();
});

test.each([null, [], { inconnu: { conges: true } }, { manager: { autre: false } }, { manager: { maladie: 'oui' } }])('refuse les droits de lecture invalides : %j', comment_reading => {
  expect(() => validatePreferences({ version: 1, comment_reading }, [], [])).toThrow(/commentaires/);
});

test.each([
  ['admin_entreprise', 21],
  ['manager', 21],
  ['employe', 18],
  ['apprenti', 18],
  ['super_admin', 0],
])('le catalogue fournit les événements destinataires du rôle %s (%i)', (role, count) => {
  expect(EVENTS.filter(event => event.roles.includes(role))).toHaveLength(count);
});

test('les relances et rapports correspondent aux destinataires des crons existants', () => {
  const roles = id => EVENTS.find(event => event.id === id).roles;
  expect(roles('leave_pending')).toEqual(['admin_entreprise', 'manager']);
  expect(roles('weekly_summary')).toEqual(['admin_entreprise', 'manager']);
  expect(roles('monthly_report')).toEqual(['admin_entreprise', 'manager']);
  for (const id of ['leave_reminder', 'leave_modify_requested', 'leave_cancel_requested', 'absence_created', 'sickness_created']) {
    expect(roles(id)).toEqual(['admin_entreprise', 'manager', 'employe', 'apprenti']);
  }
});

test('GET configuration expose les métadonnées sans retirer les anciennes préférences', async () => {
  const preferences = { version: 1, roles: {
    employe: { monthly_report: { information: { email: false, in_app: true } } },
  } };
  Entreprise.findByPk.mockResolvedValue({ parametres: { notifications: preferences }, politique_conges: {} });
  Utilisateur.findAll.mockResolvedValue([]);
  const configuration = await getConfiguration('company-a');
  expect(configuration.events).toEqual(EVENTS);
  expect(configuration.preferences).toEqual(preferences);
  expect(() => validatePreferences(preferences, [], [])).not.toThrow();
});

test('les familles regroupent tous les événements sans doublon', () => {
  expect(Object.fromEntries(['conges', 'absence_exceptionnelle', 'maladie', 'reports'].map(family => [
    family, EVENTS.filter(event => event.family === family).length,
  ]))).toEqual({ conges: 13, absence_exceptionnelle: 3, maladie: 3, reports: 2 });
});

test('un périmètre manager accepte uniquement les managers actifs de la même entreprise fournis par GET', () => {
  const preference = scope => ({ version: 1, manager_scope: scope });
  expect(() => validatePreferences(preference({ mode: 'users', user_ids: ['manager-a'] }), ['RH'], ['admin-a'], ['manager-a'])).not.toThrow();
  for (const id of ['admin-a', 'external-manager']) {
    expect(() => validatePreferences(preference({ mode: 'users', user_ids: [id] }), ['RH'], ['admin-a'], ['manager-a'])).toThrow(/entreprise/);
  }
  expect(() => validatePreferences(preference({ mode: 'services', services: ['External'] }), ['RH'], [], [])).toThrow(/entreprise/);
  expect(() => validatePreferences(preference({ mode: 'users', user_ids: [] }), [], [], [])).toThrow(/au moins/);
  expect(() => validatePreferences({ version: 1, manager_event_scopes: { monthly_report: { mode: 'company' } } }, [], [], [])).not.toThrow();
});

test.each(['email', 'in_app'])('les restrictions nommées et de service filtrent %s sans activer les canaux historiques', channel => {
  const resolve = (preferences, recipient, event = 'leave_created', service = 'RH', ownerId = 'owner', legacy = true) =>
    resolvePreference({ preferences, recipient, event, service, ownerId, legacy, channel });
  const manager = { id: 'manager-a', role: 'manager' };
  const named = { manager_scope: { mode: 'users', user_ids: ['manager-a'] } };
  expect(resolve(named, manager)).toBe(true);
  expect(resolve(named, { ...manager, id: 'manager-b' })).toBe(false);
  expect(resolve(named, manager, 'leave_created', 'RH', 'owner', false)).toBe(false);
  expect(resolve(named, { ...manager, id: 'owner' })).toBe(true);
  const scoped = { manager_scope: { mode: 'services', services: ['RH'] },
    manager_event_scopes: { leave_rejected: { mode: 'services', services: ['Finance'] } } };
  expect(resolve(scoped, manager, 'leave_created', 'Finance')).toBe(false);
  expect(resolve(scoped, manager, 'leave_rejected', 'Finance')).toBe(true);
});

test('les rapports manager restent limités aux données déjà sélectionnées et au périmètre configuré', () => {
  const rows = [{ utilisateur: { service: 'RH' } }, { utilisateur: { service: 'Finance' } }];
  expect(filterAdministrativeRecords({ manager_scope: { mode: 'services', services: ['RH'] } },
    { role: 'manager' }, 'weekly_summary', rows)).toEqual([rows[0]]);
});

test('GET ne propose que les managers actifs retournés dans le périmètre entreprise', async () => {
  Entreprise.findByPk.mockResolvedValue({ parametres: {}, politique_conges: {} });
  Utilisateur.findAll.mockResolvedValue([{ id: 'manager-a', role: 'manager' }, { id: 'admin-a', role: 'admin_entreprise' }]);
  const data = await getConfiguration('company-a');
  expect(Utilisateur.findAll).toHaveBeenLastCalledWith(expect.objectContaining({ where: { entreprise_id: 'company-a', statut: 'actif' } }));
  expect(data.managers.map(user => user.id)).toEqual(['manager-a']);
});

test('GET expose les workflows effectifs en réutilisant les règles du service et le repli entreprise', async () => {
  Entreprise.findByPk.mockResolvedValue({ politique_conges: {
    approval_workflow: 'admin_only',
    service_policies: { RH: { approval_workflow: 'manager_only' }, Finance: { approval_workflow: 'auto' } },
  } });
  Utilisateur.findAll.mockResolvedValue([{ role: 'manager', service: 'Support' }]);
  const data = await getConfiguration('company-a');
  expect(data.default_workflow).toBe('admin_only');
  expect(data.service_workflows).toEqual({ Finance: 'auto', RH: 'manager_only', Support: 'admin_only' });
});

test('valide les canaux par service avec les mêmes obligations et rejette services externes et rapports', () => {
  const prefs = roles => ({ version: 1, service_roles: roles });
  expect(() => validatePreferences(prefs({ RH: { manager: { leave_created: { action: { email: true, in_app: false } } } } }), ['RH'], [], [])).not.toThrow();
  expect(() => validatePreferences(prefs({ External: {} }), ['RH'], [], [])).toThrow(/entreprise/);
  expect(() => validatePreferences(prefs({ RH: { manager: { leave_created: { action: { email: false, in_app: false } } } } }), ['RH'], [], [])).toThrow(/Au moins/);
  expect(() => validatePreferences(prefs({ RH: { manager: { sickness_created: { action: { email: true, in_app: false } } } } }), ['RH'], [], [])).toThrow(/informatifs/);
  expect(() => validatePreferences(prefs({ RH: { manager: { weekly_summary: { information: { email: true, in_app: false } } } } }), ['RH'], [], [])).toThrow(/rapports/);
});

test.each(['action', 'information'])('priorité service > commun > historique pour %s, avec restrictions de destinataires conservées', mode => {
  const preferences = { version: 1, roles: { manager: { leave_created: { [mode]: { email: true, in_app: false } } } },
    service_roles: { RH: { manager: { leave_created: { [mode]: { email: false, in_app: true } } } } } };
  const resolve = (service, channel, legacy = true) => resolvePreference({
    preferences, recipient: { id: 'manager-a', role: 'manager' }, event: 'leave_created', mode, service, channel, legacy, ownerId: 'employee',
  });
  expect(resolve('RH', 'email')).toBe(false);
  expect(resolve('RH', 'in_app')).toBe(true);
  expect(resolve('Finance', 'email')).toBe(true);
  expect(resolve(null, 'in_app')).toBe(false);
  preferences.manager_scope = { mode: 'users', user_ids: ['another-manager'] };
  expect(resolve('RH', 'in_app')).toBe(false);
});
