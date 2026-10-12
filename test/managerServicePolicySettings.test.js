'use strict';

const request = require('supertest');
const bcrypt = require('bcrypt');
const app = require('../src/index');
const { Entreprise, Utilisateur } = require('../src/models');
const { generateToken } = require('./helpers/auth');

const RUN_ID = Date.now();
let entreprise;
let admin;
let token;

beforeAll(async () => {
  entreprise = await Entreprise.create({
    nom: `ManagerPolicyScope_${RUN_ID}`,
    politique_conges: { service_policies: {} },
    parametres: {},
    statut: 'active',
  });
  admin = await Utilisateur.create({
    entreprise_id: entreprise.id,
    prenom: 'Admin',
    nom: 'Policy Scope',
    email: `admin.policy.scope.${RUN_ID}@test.internal`,
    role: 'admin_entreprise',
    password_hash: await bcrypt.hash('Test1234!', 10),
    statut: 'actif',
  });
  token = generateToken(admin);
});

afterAll(async () => {
  await Utilisateur.destroy({ where: { id: admin?.id } }).catch(() => {});
  await Entreprise.destroy({ where: { id: entreprise?.id } }).catch(() => {});
});

const updatePolicy = (policy) => request(app)
  .put(`/api/entreprises/${entreprise.id}/politique`)
  .set('Authorization', `Bearer ${token}`)
  .send({ politique_conges: policy });

const readPolicy = () => request(app)
  .get(`/api/entreprises/${entreprise.id}/politique`)
  .set('Authorization', `Bearer ${token}`);

describe('permissions manager par service', () => {
  it('enregistre la matrice et la relit sans coupler les canaux aux droits', async () => {
    const matrix = {
      conges: { view: true, email: false, in_app: true, participation: 'action' },
      absence_exceptionnelle: { view: false, email: true, in_app: false, participation: 'information' },
      maladie: { view: true, email: false, in_app: false, participation: 'information' },
    };
    const response = await updatePolicy({ service_policies: { Finance: { manager_cross_service: matrix } } });
    expect(response.status).toBe(200);
    const persisted = await readPolicy();
    expect(persisted.body.politique_conges.service_policies.Finance.manager_cross_service).toEqual(matrix);
    expect(persisted.body.politique_conges.service_policies.Finance).toMatchObject({
      manager_can_view_all_services: true, manager_can_validate_all_services: true,
      manager_can_view_all_absences: false,
    });
  });

  it('rejette les canaux non booléens sans modifier les paramètres enregistrés', async () => {
    const initial = await readPolicy();
    const response = await updatePolicy({ service_policies: { Finance: {
      manager_cross_service: { conges: { email: 'true' } },
    } } });
    expect(response.status).toBe(400);
    expect((await readPolicy()).body.politique_conges).toEqual(initial.body.politique_conges);
  });

  it('modifier un canal ou les règles du service préserve les autres catégories et droits', async () => {
    const matrix = {
      conges: { view: true, email: true, in_app: false, participation: 'action' },
      maladie: { view: true, email: false, in_app: true, participation: 'information' },
      absence_exceptionnelle: { view: false, email: true, in_app: false, participation: 'information' },
    };
    expect((await updatePolicy({ service_policies: { Finance: { manager_cross_service: matrix } } })).status).toBe(200);
    const response = await request(app).put(`/api/entreprises/${entreprise.id}/services/Finance`)
      .set('Authorization', `Bearer ${token}`)
      .send({ policy: { manager_cross_service: { conges: { email: false } }, max_consecutive_days: 40 } });
    expect(response.status).toBe(200);
    const settings = (await readPolicy()).body.politique_conges.service_policies.Finance;
    expect(settings.manager_cross_service).toEqual({ ...matrix, conges: { ...matrix.conges, email: false } });
    expect(settings.max_consecutive_days).toBe(40);
    const rename = await request(app).put(`/api/entreprises/${entreprise.id}/services/Finance`)
      .set('Authorization', `Bearer ${token}`).send({ name: 'Finance renommée' });
    expect(rename.status).toBe(200);
    expect((await readPolicy()).body.politique_conges.service_policies['Finance renommée'].manager_cross_service)
      .toEqual(settings.manager_cross_service);
  });

  it('enregistre et relit le réglage absences indépendamment des droits sur les congés', async () => {
    const response = await updatePolicy({
      service_policies: { Finance: { manager_can_view_all_absences: true } },
    });
    expect(response.status).toBe(200);
    const persisted = await readPolicy();
    expect(persisted.status).toBe(200);
    expect(persisted.body.politique_conges.service_policies.Finance).toMatchObject({
      manager_can_view_all_absences: true,
      manager_can_view_all_services: false,
      manager_can_validate_all_services: false,
    });
  });

  it('désactive le réglage absences et ne traite pas une chaîne comme une autorisation', async () => {
    for (const value of [false, 'true']) {
      const response = await updatePolicy({
        service_policies: { Finance: { manager_can_view_all_absences: value } },
      });
      expect(response.status).toBe(200);
      expect(response.body.politique_conges.service_policies.Finance.manager_can_view_all_absences).toBe(false);
    }
  });

  it('normalise à Non/Non un service sans réglages explicites', async () => {
    const response = await updatePolicy({
      service_policies: { Finance: { approval_workflow: 'manager_admin' } },
    });

    expect(response.status).toBe(200);
    expect(response.body.politique_conges.service_policies.Finance).toMatchObject({
      manager_can_view_all_services: false,
      manager_can_validate_all_services: false,
      manager_can_view_all_absences: false,
    });

    const persisted = await readPolicy();
    expect(persisted.status).toBe(200);
    expect(persisted.body.politique_conges.service_policies.Finance.manager_can_view_all_services).toBe(false);
    expect(persisted.body.politique_conges.service_policies.Finance.manager_can_validate_all_services).toBe(false);
  });

  it('forcer la visibilité globale quand la validation globale est activée', async () => {
    const response = await updatePolicy({
      service_policies: {
        Finance: {
          approval_workflow: 'manager_admin',
          manager_can_view_all_services: false,
          manager_can_validate_all_services: true,
        },
      },
    });

    expect(response.status).toBe(200);
    const settings = response.body.politique_conges.service_policies.Finance;
    expect(settings.manager_can_view_all_services).toBe(true);
    expect(settings.manager_can_validate_all_services).toBe(true);

    const persisted = await readPolicy();
    expect(persisted.body.politique_conges.service_policies.Finance).toMatchObject({
      manager_can_view_all_services: true,
      manager_can_validate_all_services: true,
    });
  });

  it('préserve la lecture globale seule et rejette les valeurs non booléennes', async () => {
    const response = await updatePolicy({
      service_policies: {
        Finance: {
          approval_workflow: 'admin_only',
          manager_can_view_all_services: true,
          manager_can_validate_all_services: 'true',
        },
      },
    });

    expect(response.status).toBe(200);
    expect(response.body.politique_conges.service_policies.Finance).toMatchObject({
      approval_workflow: 'admin_only',
      manager_can_view_all_services: true,
      manager_can_validate_all_services: false,
    });
  });
});