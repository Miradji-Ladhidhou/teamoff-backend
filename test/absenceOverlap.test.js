'use strict';
/**
 * absenceOverlap.test.js — Fix #45
 *
 * createAbsence ne vérifie pas les chevauchements : deux absences
 * couvrant la même période pour le même utilisateur sont acceptées.
 *
 * AVANT fix : second POST → 201 (doublon créé silencieusement).
 * APRÈS fix  : second POST → 409 avec message explicite.
 *
 * Cas testés :
 *   A) Même utilisateur, périodes qui se chevauchent → 409
 *   B) Même utilisateur, adjacente (début = fin + 1 j) → 201 (non-régression)
 *   C) Utilisateur différent, même période           → 201 (isolement correct)
 */

const request = require('supertest');
const bcrypt  = require('bcrypt');
const app     = require('../src/index');
const { Entreprise, Utilisateur, Absence } = require('../src/models');
const { generateToken } = require('./helpers/auth');

const TS = Date.now();

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

let ent, emp1, emp2, tokenEmp1, tokenEmp2, tokenAdmin;

beforeAll(async () => {
  const hash = await bcrypt.hash('Test1234!', 10);

  ent = await Entreprise.create({
    nom: `AbsOvlp_${TS}`, politique_conges: {}, parametres: {}, statut: 'active',
  });

  emp1 = await Utilisateur.create({
    entreprise_id: ent.id, prenom: 'Emp1', nom: `45`,
    email: `emp1.45.${TS}@test.internal`,
    role: 'employe', password_hash: hash, statut: 'actif',
  });

  emp2 = await Utilisateur.create({
    entreprise_id: ent.id, prenom: 'Emp2', nom: `45`,
    email: `emp2.45.${TS}@test.internal`,
    role: 'employe', password_hash: hash, statut: 'actif',
  });

  const admin = await Utilisateur.create({
    entreprise_id: ent.id, prenom: 'Adm', nom: `45`,
    email: `adm.45.${TS}@test.internal`,
    role: 'admin_entreprise', password_hash: hash, statut: 'actif',
  });

  tokenEmp1  = generateToken(emp1);
  tokenEmp2  = generateToken(emp2);
  tokenAdmin = generateToken(admin);
});

afterAll(async () => {
  await Entreprise.destroy({ where: { id: ent.id } }).catch(() => {});
});

// Payload de base pour une absence valide
const baseAbsence = {
  type_absence: 'maladie',
  commentaire: 'Test doublon fix45',
};

// ─────────────────────────────────────────────────────────────────────────────
// A) Chevauchement pour le même utilisateur → rejet
// ─────────────────────────────────────────────────────────────────────────────

describe('Fix #45 — absence chevauchante rejetée', () => {

  let firstRes, overlapRes;

  beforeAll(async () => {
    // Première absence : 2027-03-01 → 2027-03-10
    firstRes = await request(app)
      .post('/api/absences')
      .set('Authorization', `Bearer ${tokenEmp1}`)
      .send({ ...baseAbsence, date_debut: '2027-03-01', date_fin: '2027-03-10' });

    // Absence chevauchante : 2027-03-05 → 2027-03-15 (chevauche les 5 derniers jours)
    overlapRes = await request(app)
      .post('/api/absences')
      .set('Authorization', `Bearer ${tokenEmp1}`)
      .send({ ...baseAbsence, date_debut: '2027-03-05', date_fin: '2027-03-15' });
  });

  afterAll(async () => {
    await Absence.destroy({ where: { utilisateur_id: emp1.id } }).catch(() => {});
  });

  it('première absence créée avec succès (201)', () => {
    expect(firstRes.status).toBe(201);
  });

  it('AVANT fix : 201 (doublon accepté) / APRÈS fix : 409', () => {
    expect(overlapRes.status).toBe(409);
  });

  it('message d\'erreur explicite mentionnant le chevauchement', () => {
    const msg = (overlapRes.body?.message || '').toLowerCase();
    expect(msg).toMatch(/chevauche|doublon|existe|période|overlap/i);
  });

  it('un seul enregistrement en base (pas de doublon)', async () => {
    const rows = await Absence.findAll({ where: { utilisateur_id: emp1.id } });
    expect(rows.length).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B) Période adjacente (pas de chevauchement) → acceptée
// ─────────────────────────────────────────────────────────────────────────────

describe('Fix #45 — absence adjacente autorisée (non-régression)', () => {

  let firstRes, adjacentRes;

  beforeAll(async () => {
    // emp2, absence 1 : 2027-04-01 → 2027-04-10
    firstRes = await request(app)
      .post('/api/absences')
      .set('Authorization', `Bearer ${tokenEmp2}`)
      .send({ ...baseAbsence, date_debut: '2027-04-01', date_fin: '2027-04-10' });

    // absence 2 : 2027-04-11 → 2027-04-15 (commence le lendemain — aucun chevauchement)
    adjacentRes = await request(app)
      .post('/api/absences')
      .set('Authorization', `Bearer ${tokenEmp2}`)
      .send({ ...baseAbsence, date_debut: '2027-04-11', date_fin: '2027-04-15' });
  });

  afterAll(async () => {
    await Absence.destroy({ where: { utilisateur_id: emp2.id } }).catch(() => {});
  });

  it('première absence : 201', () => {
    expect(firstRes.status).toBe(201);
  });

  it('absence adjacente : 201 (périodes disjointes acceptées)', () => {
    expect(adjacentRes.status).toBe(201);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C) Utilisateur différent, même période → les deux sont créées
// ─────────────────────────────────────────────────────────────────────────────

describe('Fix #45 — absences de deux employés différents sur la même période', () => {

  let res1, res2;

  beforeAll(async () => {
    // emp1 et emp2 ont tous les deux une absence sur la même période 2027-05-01→05-05.
    // Le check ne porte que sur le même utilisateur → les deux doivent être acceptées.
    await Absence.destroy({ where: { utilisateur_id: [emp1.id, emp2.id] } });

    [res1, res2] = await Promise.all([
      request(app)
        .post('/api/absences')
        .set('Authorization', `Bearer ${tokenEmp1}`)
        .send({ ...baseAbsence, date_debut: '2027-05-01', date_fin: '2027-05-05' }),
      request(app)
        .post('/api/absences')
        .set('Authorization', `Bearer ${tokenEmp2}`)
        .send({ ...baseAbsence, date_debut: '2027-05-01', date_fin: '2027-05-05' }),
    ]);
  });

  afterAll(async () => {
    await Absence.destroy({ where: { utilisateur_id: [emp1.id, emp2.id] } }).catch(() => {});
  });

  it('emp1 : 201', () => {
    expect(res1.status).toBe(201);
  });

  it('emp2 : 201 (utilisateurs différents, isolation correcte)', () => {
    expect(res2.status).toBe(201);
  });
});
