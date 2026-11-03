'use strict';

jest.mock('../../src/models', () => ({
  Entreprise: { findByPk: jest.fn() },
  Utilisateur: { findOne: jest.fn() },
  NotificationDelivery: { create: jest.fn() }, sequelize: {},
}));
jest.mock('../../src/services/systemSettingsService', () => ({
  getSettings: jest.fn().mockResolvedValue({ emailNotifications: true }),
}));
const { validatePreferences, resolvePreference, filterAdministrativeRecords } = require('../../src/services/notificationPreferencesService');
const { Entreprise, Utilisateur, NotificationDelivery } = require('../../src/models');
const { withContext, sendConfiguredEmail } = require('../../src/services/businessNotificationContext');
const preferences = report_recipients => ({ version: 1, roles: {}, report_recipients });
const validate = value => validatePreferences(value, ['RH', 'Finance'], ['a1', 'a2'], ['m1', 'm2']);

test('les destinataires sont indépendants par résumé et acceptent une liste vide', () => {
  expect(() => validate(preferences({ weekly_summary: ['a1', 'm2'], monthly_report: ['a2', 'm1', 'm2'] }))).not.toThrow();
  expect(() => validate(preferences({ weekly_summary: [], monthly_report: [] }))).not.toThrow();
});

test.each([
  { monthly_report: ['other-company'] }, { weekly_summary: ['other-company'] },
  { weekly_summary: ['employee'] }, { unknown: [] },
  { weekly_summary: ['m1', 'm1'] }, { weekly_summary: true },
])('les choix invalides ou hors entreprise sont refusés : %j', selection => {
  expect(() => validate(preferences(selection))).toThrow(/destinataires/);
});

test.each(['weekly_summary', 'monthly_report'])('%s filtre chaque personne sans modifier le contenu du périmètre', event => {
  const config = { ...preferences({ [event]: ['a2'] }),
    admin_event_scopes: { [event]: { mode: 'services', services: ['RH'] } } };
  const resolve = id => resolvePreference({ preferences: config, recipient: { id, role: 'admin_entreprise' },
    event, channel: 'email', legacy: true });
  expect(resolve('a1')).toBe(false);
  expect(resolve('a2')).toBe(true);
  const records = [{ utilisateur: { service: 'RH' } }, { utilisateur: { service: 'Finance' } }];
  expect(filterAdministrativeRecords(config, { role: 'admin_entreprise' }, event, records)).toEqual([records[0]]);
  config.report_recipients[event] = [];
  expect(resolve('a2')).toBe(false);
});

test('sans configuration les envois historiques restent inchangés et les autres événements sont préservés', () => {
  const recipient = { id: 'm1', role: 'manager' };
  expect(resolvePreference({ preferences: { version: 1, roles: {} }, recipient, event: 'weekly_summary', channel: 'email' })).toBe(true);
  expect(resolvePreference({ preferences: preferences({ weekly_summary: [] }), recipient, event: 'leave_created', channel: 'email' })).toBe(true);
  expect(resolvePreference({ recipient, event: 'monthly_report', channel: 'email' })).toBe(false);
  expect(resolvePreference({ preferences: preferences({ monthly_report: ['m1'] }), recipient, event: 'monthly_report', channel: 'email' })).toBe(true);
});

test('la sélection ne réactive pas un canal ou un périmètre historique désactivé', () => {
  const config = { ...preferences({ weekly_summary: ['m1'] }),
    roles: { manager: { weekly_summary: { workflow: { email: false } } } } };
  expect(resolvePreference({ preferences: config, recipient: { id: 'm1', role: 'manager' },
    event: 'weekly_summary', channel: 'email' })).toBe(false);
});

test.each([
  ['weekly_summary', 'weekly-manager-summary', 'manager'],
  ['monthly_report', 'monthly-report', 'admin_entreprise'],
  ['monthly_report', 'monthly-report', 'manager'],
])('%s : le véritable pipeline coupe les non-sélectionnés avant toute réservation ou envoi', async (event, templateName, role) => {
  const config = preferences({ [event]: ['selected'] });
  Entreprise.findByPk.mockResolvedValue({ id: 'company', parametres: { notifications: config } });
  Utilisateur.findOne.mockImplementation(async ({ where }) => ({
    id: where.email === 'selected@example.invalid' ? 'selected' : 'excluded',
    role, entreprise_id: 'company',
  }));
  const update = jest.fn().mockResolvedValue({});
  NotificationDelivery.create.mockResolvedValue({ update });
  const send = jest.fn().mockResolvedValue({ success: true });
  await withContext({ kind: 'summary', entrepriseId: 'company', operationId: event }, async () => {
    await sendConfiguredEmail({ to: 'excluded@example.invalid', subject: 'Résumé', templateName }, send);
    expect(send).not.toHaveBeenCalled();
    expect(NotificationDelivery.create).not.toHaveBeenCalled();
    await sendConfiguredEmail({ to: 'selected@example.invalid', subject: 'Résumé', templateName }, send);
  });
  expect(send).toHaveBeenCalledTimes(1);
  expect(NotificationDelivery.create).toHaveBeenCalledWith(expect.objectContaining({
    utilisateur_id: 'selected', entreprise_id: 'company', event,
  }));
  expect(update).toHaveBeenCalledWith({ status: 'sent' });
});
