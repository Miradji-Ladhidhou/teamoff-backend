'use strict';
/**
 * adminRejectManagerOnlyWorkflow.test.js — Fix #30
 *
 * Dans un workflow manager_only, seul le manager peut rejeter.
 * AVANT fix : un admin peut aussi rejeter → 200 (bug).
 * APRÈS fix  : rejet admin → 403 ; rejet manager → 200.
 */

const request  = require('supertest');
const bcrypt   = require('bcrypt');
const app      = require('../src/index');
const {
  Entreprise, Utilisateur, Conge, CongeType, CompteurConges,
} = require('../src/models');
const { generateToken } = require('./helpers/auth');

const PERIOD = { date_debut: '2027-09-01', date_fin: '2027-09-05' };

let entreprise, employe, manager, admin;
let congeType, tokenManager, tokenAdmin;

beforeAll(async () => {
  const hash = await bcrypt.hash('Test1234!', 10);

  entreprise = await Entreprise.create({
    nom: 'AdminRejectMgrOnly ' + Date.now(),
    politique_conges: { approval_workflow: 'manager_only' },
    parametres: {},
    statut: 'active',
  });

  employe = await Utilisateur.create({
    entreprise_id: entreprise.id,
    prenom: 'Emp', nom: 'MgrOnly30',
    email: `emp.mo30.${Date.now()}@test.internal`,
    role: 'employe', password_hash: hash, statut: 'actif',
  });

  manager = await Utilisateur.create({
    entreprise_id: entreprise.id,
    prenom: 'Mgr', nom: 'MgrOnly30',
    email: `mgr.mo30.${Date.now()}@test.internal`,
    role: 'manager', password_hash: hash, statut: 'actif',
  });

  admin = await Utilisateur.create({
    entreprise_id: entreprise.id,
    prenom: 'Adm', nom: 'MgrOnly30',
    email: `adm.mo30.${Date.now()}@test.internal`,
    role: 'admin_entreprise', password_hash: hash, statut: 'actif',
  });

  congeType = await CongeType.create({
    entreprise_id: entreprise.id,
    code: 'CP30', libelle: 'Congés payés 30',
    quota_annuel: 25, demi_journee_autorisee: true,
  });

  await CompteurConges.create({
    entreprise_id: entreprise.id,
    utilisateur_id: employe.id,
    conge_type_id: congeType.id,
    annee: 2027,
    jours_acquis: 25, jours_pris: 0, jours_reserves: 0, jours_restants: 25,
  });

  tokenManager = generateToken(manager);
  tokenAdmin   = generateToken(admin);
});

afterAll(async () => {
  await Conge.destroy({ where: { entreprise_id: entreprise.id } });
  await CompteurConges.destroy({ where: { entreprise_id: entreprise.id } });
  await CongeType.destroy({ where: { entreprise_id: entreprise.id } });
  await Utilisateur.destroy({ where: { entreprise_id: entreprise.id } });
  await Entreprise.destroy({ where: { id: entreprise.id } });
});

describe('Fix #30 — Admin ne peut pas rejeter en workflow manager_only', () => {
  let conge;

  beforeEach(async () => {
    // Créer un congé frais en_attente_manager pour chaque test
    conge = await Conge.create({
      entreprise_id: entreprise.id,
      utilisateur_id: employe.id,
      conge_type_id: congeType.id,
      ...PERIOD,
      debut_demi_journee: 'matin', fin_demi_journee: 'apres_midi',
      statut: 'en_attente_manager',
    });
  });

  afterEach(async () => {
    await Conge.destroy({ where: { id: conge.id }, force: true }).catch(() => {});
  });

  it('AVANT fix : admin rejette en workflow manager_only → doit être 403', async () => {
    const res = await request(app)
      .post(`/api/conges/${conge.id}/reject`)
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ commentaire: 'Rejet admin illégitime' });

    // APRÈS fix : 403
    expect(res.status).toBe(403);
  });

  it('manager rejette en workflow manager_only → 200 (comportement normal)', async () => {
    const res = await request(app)
      .post(`/api/conges/${conge.id}/reject`)
      .set('Authorization', `Bearer ${tokenManager}`)
      .send({ commentaire: 'Rejet manager légitime' });

    expect(res.status).toBe(200);
    expect(res.body.statut).toBe('refuse_manager');
  });

  it('admin ne peut pas non plus rejeter un conge valide_manager en workflow manager_only', async () => {
    // Simuler le passage en valide_manager (le manager a validé)
    await conge.update({ statut: 'valide_manager' });

    const res = await request(app)
      .post(`/api/conges/${conge.id}/reject`)
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ commentaire: 'Tentative de rejet admin après validation manager' });

    expect(res.status).toBe(403);
  });
});
