'use strict';
/**
 * exportPreviewPrivilege.test.js
 *
 * Vérifie que GET /api/exports/preview?type=<type> applique les mêmes droits
 * que les routes CSV/PDF correspondantes.
 *
 * AVANT fix : un manager peut appeler type=audit et type=utilisateurs → 200
 * APRÈS fix  : type=audit et type=utilisateurs → 403 pour un manager
 */

const request = require('supertest');
const app = require('../src/index');
const { Entreprise, Utilisateur } = require('../src/models');
const { generateToken } = require('./helpers/auth');

let entreprise, manager, adminEntreprise, managerToken, adminToken;

beforeAll(async () => {
  entreprise = await Entreprise.create({
    nom: 'TestExportPreview-' + Date.now(),
    politique_conges: {},
    parametres: {},
  });

  manager = await Utilisateur.create({
    prenom: 'Manager', nom: 'Test',
    email: `manager.preview.${Date.now()}@test.local`,
    role: 'manager',
    password_hash: 'hash',
    statut: 'actif',
    entreprise_id: entreprise.id,
  });

  adminEntreprise = await Utilisateur.create({
    prenom: 'Admin', nom: 'Entreprise',
    email: `admin.preview.${Date.now()}@test.local`,
    role: 'admin_entreprise',
    password_hash: 'hash',
    statut: 'actif',
    entreprise_id: entreprise.id,
  });

  managerToken = generateToken(manager);
  adminToken = generateToken(adminEntreprise);
});

afterAll(async () => {
  if (manager)         await Utilisateur.destroy({ where: { id: manager.id } }).catch(() => {});
  if (adminEntreprise) await Utilisateur.destroy({ where: { id: adminEntreprise.id } }).catch(() => {});
  if (entreprise)      await Entreprise.destroy({ where: { id: entreprise.id } }).catch(() => {});
});

describe('GET /api/exports/preview — contrôle des droits par type', () => {
  // Types accessibles aux managers (conges, absences, arrets_maladie)
  const managerTypes = ['conges', 'absences', 'arrets_maladie'];
  // Types réservés aux admin_entreprise+ (audit, utilisateurs, usage/statistiques)
  const adminOnlyTypes = ['audit', 'utilisateurs', 'usage', 'statistiques'];

  for (const type of managerTypes) {
    it(`manager peut accéder à type=${type} (200)`, async () => {
      const res = await request(app)
        .get(`/api/exports/preview?type=${type}`)
        .set('Authorization', `Bearer ${managerToken}`);
      expect(res.status).toBe(200);
    });
  }

  for (const type of adminOnlyTypes) {
    it(`manager reçoit 403 pour type=${type} (données sensibles)`, async () => {
      const res = await request(app)
        .get(`/api/exports/preview?type=${type}`)
        .set('Authorization', `Bearer ${managerToken}`);
      expect(res.status).toBe(403);
    });
  }

  for (const type of adminOnlyTypes) {
    it(`admin_entreprise peut accéder à type=${type} (200)`, async () => {
      const res = await request(app)
        .get(`/api/exports/preview?type=${type}`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
    });
  }

  it('type inconnu retourne 400', async () => {
    const res = await request(app)
      .get('/api/exports/preview?type=hackertype')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
  });
});
