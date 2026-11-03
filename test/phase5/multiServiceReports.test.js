'use strict';

jest.mock('../../src/models', () => ({
  Entreprise: { findAll: jest.fn(), findByPk: jest.fn() },
  Utilisateur: { findAll: jest.fn(), findOne: jest.fn(), count: jest.fn() },
  Conge: { findAll: jest.fn() }, Absence: { findAll: jest.fn() },
  NotificationDelivery: { create: jest.fn() },
}));
jest.mock('../../src/services/emailService', () => ({
  sendMonthlyReport: jest.fn(), sendWeeklySummary: jest.fn(),
}));
jest.mock('../../src/services/systemSettingsService', () => ({
  getSettings: jest.fn().mockResolvedValue({ emailNotifications: true }),
}));
jest.mock('../../src/services/notificationService', () => ({}));
jest.mock('../../src/utils/logger', () => ({ info: jest.fn(), error: jest.fn() }));

const { Op, UniqueConstraintError } = require('sequelize');
const models = require('../../src/models');
const emailService = require('../../src/services/emailService');
const logger = require('../../src/utils/logger');
const { sendConfiguredEmail } = require('../../src/services/businessNotificationContext');
const { getSettings } = require('../../src/services/systemSettingsService');
const { runMonthlyReports, runWeeklyManagerSummary } = require('../../src/cron/emailCron');
let companies, users, employees, leaves, absences, delivered, claims;

const manager = (id, service, entreprise_id = 'company') => ({
  id, service, entreprise_id, role: 'manager', email: `${id}@example.invalid`, statut: 'actif',
});
const admin = (id, entreprise_id = 'company') => ({
  id, entreprise_id, service: id === 'a2' ? 'Finance' : 'RH',
  role: 'admin_entreprise', email: `${id}@example.invalid`, statut: 'actif',
});
const company = id => ({ id, nom: id, statut: 'active', parametres: { notifications: {
  version: 1, roles: {}, report_recipients: {},
} }, politique_conges: {} });

beforeEach(() => {
  getSettings.mockResolvedValue({ emailNotifications: true });
  companies = [company('company'), company('other')];
  users = [manager('m1', 'RH'), manager('m2', 'RH'), manager('m3', 'Finance'),
    admin('a1'), admin('a2'), manager('external', 'RH', 'other'), admin('external-admin', 'other')];
  companies[0].parametres.notifications.report_recipients = {
    weekly_summary: ['m1', 'm2', 'm3', 'a1', 'a2'],
    monthly_report: ['m1', 'm2', 'm3', 'a1', 'a2'],
  };
  companies[1].parametres.notifications.report_recipients = {
    weekly_summary: ['external', 'external-admin'], monthly_report: ['external', 'external-admin'],
  };
  companies[0].politique_conges.notification_routing = {
    Finance: { conges: { m1: { mode: 'information', email: true, in_app: false } } },
  };
  employees = [
    { id: 'e1', service: 'RH', entreprise_id: 'company' },
    { id: 'e2', service: 'Finance', entreprise_id: 'company' },
    { id: 'e3', service: 'Support', entreprise_id: 'company' },
    { id: 'e4', service: 'RH', entreprise_id: 'other' },
  ];
  leaves = employees.map((utilisateur, i) => ({
    id: `leave-${i}`, entreprise_id: utilisateur.entreprise_id, utilisateur, jours_calcules: i + 1,
  }));
  absences = employees.flatMap((utilisateur, i) => ['maladie', 'absence_exceptionnelle'].map(type_absence => ({
    id: `${type_absence}-${i}`, entreprise_id: utilisateur.entreprise_id, utilisateur, type_absence,
  })));
  delivered = [];
  claims = new Set();
  models.Entreprise.findAll.mockResolvedValue(companies);
  models.Entreprise.findByPk.mockImplementation(async id => companies.find(item => item.id === id));
  models.Utilisateur.findOne.mockImplementation(async ({ where }) => users.find(item => item.email === where.email));
  models.Utilisateur.findAll.mockImplementation(async ({ where, attributes }) => {
    const source = attributes.length === 2 ? employees : users;
    const result = source.filter(item => (!where.entreprise_id || item.entreprise_id === where.entreprise_id)
      && (typeof where.role !== 'string' || item.role === where.role));
    return attributes.length !== 2 && result.some(item => item.id === 'm1')
      ? [...result, result.find(item => item.id === 'm1')] : result;
  });
  models.Utilisateur.count.mockImplementation(async ({ where }) => employees.filter(item =>
    item.entreprise_id === where.entreprise_id && (!where.service || where.service[Op.in].includes(item.service))).length);
  models.Conge.findAll.mockImplementation(async ({ where }) => leaves.filter(item => item.entreprise_id === where.entreprise_id));
  models.Absence.findAll.mockImplementation(async ({ where }) => absences.filter(item => item.entreprise_id === where.entreprise_id));
  models.NotificationDelivery.create.mockImplementation(async data => {
    if (claims.has(data.key)) throw new UniqueConstraintError({});
    claims.add(data.key);
    return { update: jest.fn().mockResolvedValue({}) };
  });
  emailService.sendMonthlyReport.mockImplementation(async (to, report, entreprise) =>
    sendConfiguredEmail({ to, subject: 'Mensuel', templateName: 'monthly-report' }, async () => {
      delivered.push({ to, report, company: entreprise.id });
      return { success: true };
    }));
  emailService.sendWeeklySummary.mockImplementation(async (recipient, conges, absences) =>
    sendConfiguredEmail({ to: recipient.email, subject: 'Hebdomadaire', templateName: 'weekly-manager-summary' }, async () => {
      delivered.push({ to: recipient.email, conges, absences, company: recipient.entreprise_id });
      return { success: true };
    }));
});

test('mensuel : plusieurs managers, services et admins avec des totaux individuels et sans fuite interentreprises', async () => {
  await runMonthlyReports();
  const report = id => delivered.find(item => item.to === `${id}@example.invalid`).report;
  expect(delivered).toHaveLength(7);
  expect(report('m1')).toMatchObject({ total_conges: 2, total_jours: 3, total_absences: 2, total_employes: 2 });
  expect(report('m2')).toMatchObject({ total_conges: 1, total_jours: 1, total_absences: 2, total_employes: 1 });
  expect(report('m3')).toMatchObject({ total_conges: 1, total_jours: 2, total_absences: 2, total_employes: 1 });
  for (const id of ['a1', 'a2']) {
    expect(report(id)).toMatchObject({ total_conges: 3, total_jours: 6, total_absences: 6, total_employes: 3 });
  }
  expect(report('external')).toMatchObject({ total_conges: 1, total_jours: 4, total_absences: 2, total_employes: 1 });
  expect(logger.error).not.toHaveBeenCalled();
});

test.each([
  ['hebdomadaire', runWeeklyManagerSummary],
  ['mensuel', runMonthlyReports],
])('%s : les relances ne dupliquent pas les envois', async (label, run) => {
  await run();
  expect(delivered).toHaveLength(7);
  await run();
  expect(delivered).toHaveLength(7);
});

test('hebdomadaire : mêmes périmètres nominatifs par service et par catégorie', async () => {
  await runWeeklyManagerSummary();
  const result = id => delivered.find(item => item.to === `${id}@example.invalid`);
  expect(result('m1').conges.map(item => item.utilisateur.service)).toEqual(['RH', 'Finance']);
  expect(result('m1').absences.map(item => item.utilisateur.service)).toEqual(['RH', 'RH']);
  expect(result('m2').conges.map(item => item.utilisateur.service)).toEqual(['RH']);
  expect(result('m3').conges.map(item => item.utilisateur.service)).toEqual(['Finance']);
  expect(result('a1').conges).toHaveLength(3);
  expect(result('a2').absences).toHaveLength(6);
  for (const item of delivered) {
    expect([...item.conges, ...item.absences].every(record => record.entreprise_id === item.company)).toBe(true);
  }
});

test('sans sélection mensuelle, les admins historiques restent abonnés mais pas les managers', async () => {
  for (const item of companies) delete item.parametres.notifications.report_recipients.monthly_report;
  await runMonthlyReports();
  expect(delivered.map(item => item.to).sort()).toEqual([
    'a1@example.invalid', 'a2@example.invalid', 'external-admin@example.invalid',
  ]);
});

test('un abonnement mensuel explicite par rôle manager reste pris en compte', async () => {
  for (const item of companies) delete item.parametres.notifications.report_recipients.monthly_report;
  companies[0].parametres.notifications.roles.manager = { monthly_report: { workflow: { email: true } } };
  await runMonthlyReports();
  expect(delivered.map(item => item.to)).toEqual(expect.arrayContaining([
    'm1@example.invalid', 'm2@example.invalid', 'm3@example.invalid', 'a1@example.invalid', 'a2@example.invalid',
  ]));
  expect(delivered.some(item => item.to === 'external@example.invalid')).toBe(false);
});

test.each([
  ['hebdomadaire', 'weekly_summary', runWeeklyManagerSummary],
  ['mensuel', 'monthly_report', runMonthlyReports],
])('%s : ne pas prévenir et les canaux par catégorie restent prioritaires', async (label, event, run) => {
  companies[0].politique_conges.notification_routing.RH = {
    conges: { m2: { mode: 'none', email: false, in_app: false } },
    maladie: { m2: { mode: 'none', email: false, in_app: false } },
  };
  companies[0].parametres.notifications.roles.admin_entreprise = { [event]: { workflow: { email: false } } };
  await run();
  expect(delivered.some(item => item.to === 'a1@example.invalid')).toBe(false);
  expect(delivered.some(item => item.to === 'a2@example.invalid')).toBe(false);
  const result = delivered.find(item => item.to === 'm2@example.invalid');
  if (event === 'monthly_report') {
    expect(result.report).toMatchObject({ total_conges: 0, total_jours: 0, total_absences: 1, total_employes: 0 });
    expect(result.report.top_absences).toEqual(['Absence exceptionnelle (1)']);
  } else {
    expect(result.conges).toHaveLength(0);
    expect(result.absences.map(item => item.type_absence)).toEqual(['absence_exceptionnelle']);
  }
});

test.each([
  ['hebdomadaire', 'weekly_summary', runWeeklyManagerSummary],
  ['mensuel', 'monthly_report', runMonthlyReports],
])('%s : liste vide et sélection individuelle respectées', async (label, event, run) => {
  companies[0].parametres.notifications.report_recipients[event] = ['m2', 'a2'];
  companies[1].parametres.notifications.report_recipients[event] = [];
  await run();
  expect(delivered.map(item => item.to).sort()).toEqual(['a2@example.invalid', 'm2@example.invalid']);
});

test('les filtres de service des managers et admins restent une intersection des accès existants', async () => {
  Object.assign(companies[0].parametres.notifications, {
    manager_event_scopes: { monthly_report: { mode: 'services', services: ['Finance'] } },
    admin_event_scopes: { monthly_report: { mode: 'services', services: ['RH'] } },
  });
  await runMonthlyReports();
  const report = id => delivered.find(item => item.to === `${id}@example.invalid`).report;
  expect(report('m1')).toMatchObject({ total_conges: 1, total_absences: 0, total_employes: 1 });
  expect(report('m2')).toMatchObject({ total_conges: 0, total_absences: 0, total_employes: 0 });
  expect(report('a1')).toMatchObject({ total_conges: 1, total_absences: 2, total_employes: 1 });
  expect(report('a2')).toMatchObject({ total_conges: 1, total_absences: 2, total_employes: 1 });
});

test('une erreur pour un destinataire ne bloque pas les suivants', async () => {
  emailService.sendMonthlyReport.mockImplementationOnce(async () => { throw new Error('Erreur fictive'); });
  await runMonthlyReports();
  expect(logger.error).toHaveBeenCalledWith('[email-cron] sendMonthlyReport error', expect.objectContaining({
    error: 'Erreur fictive', entrepriseId: 'company',
  }));
  expect(delivered).toHaveLength(6);
});

test.each([
  ['hebdomadaire', runWeeklyManagerSummary],
  ['mensuel', runMonthlyReports],
])('%s : la désactivation globale des emails bloque tous les envois', async (label, run) => {
  getSettings.mockResolvedValue({ emailNotifications: false });
  await run();
  expect(delivered).toHaveLength(0);
  expect(models.NotificationDelivery.create).not.toHaveBeenCalled();
});

test('un rapport mensuel vide reste envoyé avec des totaux cohérents', async () => {
  leaves = [];
  absences = [];
  await runMonthlyReports();
  expect(delivered).toHaveLength(7);
  for (const item of delivered) {
    expect(item.report).toMatchObject({ total_conges: 0, total_jours: 0, total_absences: 0, top_absences: [] });
  }
});
