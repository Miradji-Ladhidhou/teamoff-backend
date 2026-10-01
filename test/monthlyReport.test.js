'use strict';

const { Absence, Conge, Entreprise, Utilisateur } = require('../src/models');
const emailService = require('../src/services/emailService');
const { runMonthlyReports } = require('../src/cron/emailCron');

afterEach(() => {
  jest.restoreAllMocks();
});

test('le rapport mensuel envoie des indicateurs cohérents pour le mois précédent', async () => {
  const entreprise = { id: 'c230d673-49a0-40d7-a9c8-71da5f252516', nom: 'TeamOff Test', statut: 'active' };
  const admin = { id: 'admin-id', email: 'admin@example.test' };
  const conges = [
    { jours_calcules: '1.50', conge_type: { libelle: 'Congés payés' } },
    { jours_calcules: '2.00', conge_type: { libelle: 'Congés payés' } },
    { jours_calcules: '3', conge_type: { libelle: 'RTT' } },
  ];
  const absences = [
    { type_absence: 'maladie' },
    { type_absence: 'maladie' },
    { type_absence: 'absence_exceptionnelle' },
  ];

  jest.spyOn(Entreprise, 'findAll').mockResolvedValue([entreprise]);
  jest.spyOn(Conge, 'findAll').mockResolvedValue(conges);
  jest.spyOn(Absence, 'findAll').mockResolvedValue(absences);
  jest.spyOn(Utilisateur, 'count').mockResolvedValue(8);
  jest.spyOn(Utilisateur, 'findAll').mockResolvedValue([admin]);
  const sendMonthlyReport = jest.spyOn(emailService, 'sendMonthlyReport').mockResolvedValue(undefined);

  await runMonthlyReports();

  const [recipient, report, sentEntreprise] = sendMonthlyReport.mock.calls[0];
  expect(recipient).toBe(admin.email);
  expect(sentEntreprise).toBe(entreprise);
  expect(report).toMatchObject({
    mois: 'septembre',
    annee: 2026,
    periode_debut: '01/09/2026',
    periode_fin: '30/09/2026',
    total_conges: 3,
    total_jours: 6.5,
    total_employes: 8,
    total_absences: 3,
    top_absences: ['Maladie (2)', 'Absence exceptionnelle (1)'],
  });

  const start = Conge.findAll.mock.calls[0][0].where.date_debut[require('sequelize').Op.between];
  expect(start[0]).toBe('2026-09-01');
  expect(start[1]).toBe('2026-09-30');
});

test('le service email transmet au template tous les indicateurs calculés', async () => {
  const sendEmail = jest.spyOn(emailService, 'sendEmail').mockResolvedValue(undefined);
  const entreprise = { nom: 'TeamOff Test' };

  await emailService.sendMonthlyReport('admin@example.test', {
    mois: 'septembre',
    annee: 2026,
    periode_debut: '01/09/2026',
    periode_fin: '30/09/2026',
    total_conges: 3,
    total_jours: 6.5,
    total_employes: 8,
    total_absences: 3,
    top_absences: ['Maladie (2)', 'Absence exceptionnelle (1)'],
  }, entreprise);

  expect(sendEmail).toHaveBeenCalledWith(
    'admin@example.test',
    'Rapport mensuel de septembre 2026',
    'monthly-report',
    expect.objectContaining({
      mois: 'septembre',
      annee: 2026,
      periode_debut: '01/09/2026',
      periode_fin: '30/09/2026',
      total_conges: 3,
      total_jours: 6.5,
      total_employes: 8,
      total_absences: 3,
      top_absences: 'Maladie (2), Absence exceptionnelle (1)',
    })
  );
});