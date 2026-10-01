'use strict';

const { Conge, CompteurConges } = require('../src/models');
const joursFeriesService = require('../src/services/joursFeriesService');
const congeController = require('../src/controllers/congeController');

afterEach(() => {
  jest.restoreAllMocks();
});

test('l’attestation compte aussi un jour férié qui tombe un samedi compté', async () => {
  const conge = {
    id: '4d34c1ea-1df2-46a9-8673-3d74e9961e1c',
    entreprise_id: 'c230d673-49a0-40d7-a9c8-71da5f252516',
    utilisateur_id: 'e3e35acf-a6aa-42fc-900f-a4a5c8362cd8',
    conge_type_id: '79ed5529-f5c0-4d2a-a09f-89d430ef4b82',
    date_debut: '2026-10-09',
    date_fin: '2026-10-13',
    statut: 'valide_final',
    jours_calcules: 2,
    utilisateur: { id: 'e3e35acf-a6aa-42fc-900f-a4a5c8362cd8', prenom: 'Local', nom: 'Employé', email: 'local.employe@teamoff.test' },
    conge_type: { libelle: 'Test férié 2026' },
    entreprise: {
      nom: 'TeamOff Local Test Accounts',
      parametres: {},
      politique_conges: {
        blocked_days: {
          exclude_weekends: true,
          exclude_holidays: true,
          count_saturday: true,
          count_sunday: false,
        },
      },
    },
  };

  jest.spyOn(Conge, 'findByPk').mockResolvedValue(conge);
  jest.spyOn(CompteurConges, 'findOne').mockResolvedValue(null);
  jest.spyOn(joursFeriesService, 'getJoursFeriesEntreprise').mockResolvedValue([
    { date: '2026-10-10', libelle: 'Férié test samedi', recurrent: false, est_travail: false },
    { date: '2026-10-12', libelle: 'Férié test lundi', recurrent: false, est_travail: false },
  ]);

  const response = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };

  await congeController.getAttestationData({
    params: { id: conge.id },
    user: { id: 'admin-id', role: 'admin_entreprise', entreprise_id: conge.entreprise_id },
  }, response, (error) => { throw error; });

  const feries = response.body.jours.detail.filter((day) => day.type === 'ferie');
  expect(feries).toHaveLength(2);
  expect(feries.map((day) => day.date)).toEqual(['2026-10-10', '2026-10-12']);
});