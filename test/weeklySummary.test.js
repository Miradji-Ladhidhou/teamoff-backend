'use strict';

const { Absence, Conge, Entreprise, Utilisateur } = require('../src/models');
const { Op } = require('sequelize');
const dayjs = require('dayjs');
const emailService = require('../src/services/emailService');
const { runWeeklyManagerSummary } = require('../src/cron/emailCron');

afterEach(() => {
  jest.restoreAllMocks();
});

test('le résumé hebdomadaire est envoyé aux managers et aux admins actifs de leur entreprise', async () => {
  const entrepriseId = 'entreprise-1';
  const manager = {
    id: 'manager-1',
    email: 'manager@example.test',
    role: 'manager',
    entreprise_id: entrepriseId,
    service: 'RH',
  };
  const admin1 = {
    id: 'admin-1',
    email: 'admin1@example.test',
    role: 'admin_entreprise',
    entreprise_id: entrepriseId,
  };
  const admin2 = {
    id: 'admin-2',
    email: 'admin2@example.test',
    role: 'admin_entreprise',
    entreprise_id: entrepriseId,
  };
  const conges = [
    { utilisateur: { service: 'RH' }, date_debut: '2026-10-05', date_fin: '2026-10-06' },
    { utilisateur: { service: 'Finance' }, date_debut: '2026-10-05', date_fin: '2026-10-06' },
  ];
  const absences = [
    { utilisateur: { service: 'RH' }, type_absence: 'maladie', date_debut: '2026-10-05', date_fin: '2026-10-06' },
    { utilisateur: { service: 'Finance' }, type_absence: 'absence_exceptionnelle', date_debut: '2026-10-05', date_fin: '2026-10-06' },
  ];

  jest.spyOn(Utilisateur, 'findAll')
    .mockResolvedValueOnce([manager])
    .mockResolvedValueOnce([admin1, admin2]);
  jest.spyOn(Entreprise, 'findAll').mockResolvedValue([{
    id: entrepriseId,
    politique_conges: {
      service_policies: { RH: { manager_can_view_all_services: false } },
    },
  }]);
  jest.spyOn(Conge, 'findAll').mockResolvedValue(conges);
  jest.spyOn(Absence, 'findAll').mockResolvedValue(absences);
  const sendWeeklySummary = jest.spyOn(emailService, 'sendWeeklySummary').mockResolvedValue(undefined);

  await runWeeklyManagerSummary();

  expect(sendWeeklySummary).toHaveBeenCalledTimes(3);
  expect(sendWeeklySummary).toHaveBeenNthCalledWith(1, manager, [conges[0]], [absences[0]], expect.any(Date), expect.any(Date));
  expect(sendWeeklySummary).toHaveBeenNthCalledWith(2, admin1, conges, absences, expect.any(Date), expect.any(Date));
  expect(sendWeeklySummary).toHaveBeenNthCalledWith(3, admin2, conges, absences, expect.any(Date), expect.any(Date));
  expect(Absence.findAll.mock.calls[0][0].where).toMatchObject({
    entreprise_id: entrepriseId,
    statut: { [require('sequelize').Op.in]: ['signalée', 'approuvée'] },
  });
  expect(Absence.findAll.mock.calls[0][0].where.date_debut[require('sequelize').Op.lte]).toEqual(expect.any(String));
  expect(Absence.findAll.mock.calls[0][0].where.date_fin[require('sequelize').Op.gte]).toEqual(expect.any(String));
  const weekStartDate = dayjs(sendWeeklySummary.mock.calls[0][3]).format('YYYY-MM-DD');
  const weekEndDate = dayjs(sendWeeklySummary.mock.calls[0][4]).format('YYYY-MM-DD');
  expect(Conge.findAll.mock.calls[0][0].where).toEqual({
    entreprise_id: entrepriseId,
    statut: 'valide_final',
    date_debut: { [Op.lte]: weekEndDate },
    date_fin: { [Op.gte]: weekStartDate },
  });
  expect(Absence.findAll.mock.calls[0][0].where).toEqual({
    entreprise_id: entrepriseId,
    statut: { [Op.in]: ['signalée', 'approuvée'] },
    date_debut: { [Op.lte]: weekEndDate },
    date_fin: { [Op.gte]: weekStartDate },
  });
});

test('le courriel hebdomadaire présente les congés et les absences dans le récapitulatif', async () => {
  const sendEmail = jest.spyOn(emailService, 'sendEmail').mockResolvedValue(undefined);
  const recipient = { email: 'admin@example.test', prenom: 'Alex', nom: 'Admin' };
  const conges = [{
    utilisateur: { prenom: 'Camille', nom: 'Martin', service: 'RH' },
    conge_type: { libelle: 'Congés payés' },
    date_debut: '2026-09-28',
    date_fin: '2026-10-16',
  }];
  const absences = [{
    utilisateur: { prenom: 'Sam', nom: 'Durand', service: 'Finance' },
    type_absence: 'maladie',
    date_debut: '2026-10-02',
    date_fin: '2026-10-20',
  }];

  await emailService.sendWeeklySummary(recipient, conges, absences, new Date('2026-10-05'), new Date('2026-10-11'));

  expect(sendEmail).toHaveBeenCalledWith(
    recipient.email,
    'Résumé de la semaine — 1 congé(s), 1 absence(s)',
    'weekly-manager-summary',
    expect.objectContaining({
      total_conges: '1',
      total_absences: '1',
      service_summary_rows: expect.stringContaining('Finance'),
      table_rows: expect.stringContaining('Absence maladie'),
    })
  );
  const templateData = sendEmail.mock.calls[0][3];
  expect(templateData.service_summary_rows).toContain('RH');
  expect(templateData.service_summary_rows).toContain('Finance');
  expect(templateData.table_rows).toContain('28/09/2026');
  expect(templateData.table_rows).toContain('16/10/2026');
  expect(templateData.table_rows).toContain('02/10/2026');
  expect(templateData.table_rows).toContain('20/10/2026');
  expect(templateData.table_rows).not.toContain('05/10/2026');
  expect(templateData.table_rows).not.toContain('11/10/2026');
});

test('le résumé hebdomadaire est envoyé même sans congé ni absence', async () => {
  const admin = {
    id: 'admin-empty',
    email: 'admin@example.test',
    role: 'admin_entreprise',
    entreprise_id: 'entreprise-empty',
  };

  jest.spyOn(Utilisateur, 'findAll')
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([admin]);
  jest.spyOn(Entreprise, 'findAll').mockResolvedValue([]);
  jest.spyOn(Conge, 'findAll').mockResolvedValue([]);
  jest.spyOn(Absence, 'findAll').mockResolvedValue([]);
  const sendWeeklySummary = jest.spyOn(emailService, 'sendWeeklySummary').mockResolvedValue(undefined);

  await runWeeklyManagerSummary();

  expect(sendWeeklySummary).toHaveBeenCalledTimes(1);
  expect(sendWeeklySummary).toHaveBeenCalledWith(admin, [], [], expect.any(Date), expect.any(Date));
});

test('un manager autorisé reçoit les données de tous les services, avec un récapitulatif par service', async () => {
  const manager = {
    id: 'manager-cross-service',
    email: 'manager@example.test',
    role: 'manager',
    entreprise_id: 'entreprise-cross-service',
    service: 'RH',
  };
  const conges = [
    { utilisateur: { service: 'RH' }, date_debut: '2026-10-05', date_fin: '2026-10-06' },
    { utilisateur: { service: 'Finance' }, date_debut: '2026-10-05', date_fin: '2026-10-06' },
  ];

  jest.spyOn(Utilisateur, 'findAll')
    .mockResolvedValueOnce([manager])
    .mockResolvedValueOnce([]);
  jest.spyOn(Entreprise, 'findAll').mockResolvedValue([{
    id: manager.entreprise_id,
    politique_conges: {
      service_policies: { RH: { manager_can_view_all_services: true } },
    },
  }]);
  jest.spyOn(Conge, 'findAll').mockResolvedValue(conges);
  jest.spyOn(Absence, 'findAll').mockResolvedValue([]);
  const sendWeeklySummary = jest.spyOn(emailService, 'sendWeeklySummary').mockResolvedValue(undefined);

  await runWeeklyManagerSummary();

  expect(sendWeeklySummary).toHaveBeenCalledTimes(1);
  expect(sendWeeklySummary).toHaveBeenCalledWith(manager, conges, [], expect.any(Date), expect.any(Date));
});
