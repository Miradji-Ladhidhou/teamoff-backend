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
  it('normalise à Non/Non un service sans réglages explicites', async () => {
    const response = await updatePolicy({
      service_policies: { Finance: { approval_workflow: 'manager_admin' } },
    });

    expect(response.status).toBe(200);
    expect(response.body.politique_conges.service_policies.Finance).toMatchObject({
      manager_can_view_all_services: false,
      manager_can_validate_all_services: false,
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