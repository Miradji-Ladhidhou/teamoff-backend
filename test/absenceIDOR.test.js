'use strict';
/**
 * absenceIDOR.test.js
 *
 * Vérifie que POST /api/absences refuse la création d'une absence
 * pour un utilisateur appartenant à une autre entreprise (IDOR).
 *
 * AVANT fix : un manager de l'entreprise A peut créer une absence
 *             pour un employé de l'entreprise B → 201 (bug)
 * APRÈS fix  : tentative cross-entreprise → 403 ;
 *              création dans la même entreprise → 201 (toujours)
 */

const request = require('supertest');
const app = require('../src/index');
const { Entreprise, Utilisateur, Absence } = require('../src/models');
const { generateToken } = require('./helpers/auth');

let entrepriseA, entrepriseB;
let managerA, employeA, employeB;
const suffix = String(Date.now()).slice(-6);

beforeAll(async () => {
  entrepriseA = await Entreprise.create({
    nom: 'AbsIDOR-A-' + suffix,
    politique_conges: {},
    parametres: {},
  });

  entrepriseB = await Entreprise.create({
    nom: 'AbsIDOR-B-' + suffix,
    politique_conges: {},
    parametres: {},
  });

  managerA = await Utilisateur.create({
    prenom: 'Manager', nom: 'A',
    email: `mgr.a.${suffix}@test.local`,
    role: 'manager', password_hash: 'hash', statut: 'actif',
    entreprise_id: entrepriseA.id,
  });

  employeA = await Utilisateur.create({
    prenom: 'Employe', nom: 'A',
    email: `emp.a.${suffix}@test.local`,
    role: 'employe', password_hash: 'hash', statut: 'actif',
    service: 'Dev',
    entreprise_id: entrepriseA.id,
  });

  employeB = await Utilisateur.create({
    prenom: 'Employe', nom: 'B',
    email: `emp.b.${suffix}@test.local`,
    role: 'employe', password_hash: 'hash', statut: 'actif',
    service: 'Dev',
    entreprise_id: entrepriseB.id,
  });
});

afterAll(async () => {
  // Nettoyer les absences éventuellement créées sur employeB (le bug les aurait créées)
  await Absence.destroy({ where: { utilisateur_id: employeB.id } }).catch(() => {});
  await Absence.destroy({ where: { utilisateur_id: employeA.id } }).catch(() => {});

  for (const u of [managerA, employeA, employeB]) {
    if (u) await Utilisateur.destroy({ where: { id: u.id } }).catch(() => {});
  }
  for (const e of [entrepriseA, entrepriseB]) {
    if (e) await Entreprise.destroy({ where: { id: e.id } }).catch(() => {});
  }
});

const ABSENCE_PAYLOAD = {
  type_absence: 'absence_exceptionnelle',
  date_debut: '2025-09-01',
  date_fin: '2025-09-01',
  commentaire: 'test IDOR',
};

describe('absenceController — IDOR cross-entreprise', () => {
  it('manager A peut créer une absence pour employé B (autre entreprise) — bug', async () => {
    const token = generateToken(managerA);
    const res = await request(app)
      .post('/api/absences')
      .set('Authorization', `Bearer ${token}`)
      .send({ ...ABSENCE_PAYLOAD, utilisateur_id: employeB.id });

    // AVANT fix : 201 (bug) — APRÈS fix : 403
    expect(res.status).toBe(403);
  });

  it('manager A peut créer une absence pour employé A (même entreprise) — cas normal', async () => {
    const token = generateToken(managerA);
    const res = await request(app)
      .post('/api/absences')
      .set('Authorization', `Bearer ${token}`)
      .send({ ...ABSENCE_PAYLOAD, utilisateur_id: employeA.id });

    expect(res.status).toBe(201);
  });

  it('manager A peut créer une absence pour lui-même (pas de utilisateur_id)', async () => {
    const token = generateToken(managerA);
    const res = await request(app)
      .post('/api/absences')
      .set('Authorization', `Bearer ${token}`)
      .send(ABSENCE_PAYLOAD);

    expect(res.status).toBe(201);
  });
});
