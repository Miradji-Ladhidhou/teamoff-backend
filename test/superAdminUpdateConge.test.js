'use strict';
/**
 * superAdminUpdateConge.test.js — Fix #44
 *
 * updateConge refuse le super_admin à la ligne :
 *   if (user?.role !== 'admin_entreprise' && user?.id !== conge.utilisateur_id)
 *     throw new Error('Modification non autorisée');
 *
 * AVANT fix : super_admin → 400 « Modification non autorisée »
 * APRÈS fix  : super_admin → 200 (modification acceptée)
 *
 * Cas testés :
 *   A) super_admin modifie le congé d'un employé d'une autre entreprise   → 200
 *   B) admin_entreprise modifie le congé d'un employé de sa propre ent.   → 200 (non-régression)
 *   C) employe d'une entreprise B essaie de modifier un congé de l'ent. A → 400 (isolation inchangée)
 */

const request = require('supertest');
const bcrypt  = require('bcrypt');
const app     = require('../src/index');
const {
  Entreprise, Utilisateur, CongeType, CompteurConges, Conge,
} = require('../src/models');
const { generateToken } = require('./helpers/auth');
const dayjs = require('dayjs');

const TS   = Date.now();
const YEAR = dayjs().year();

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures globales
// ─────────────────────────────────────────────────────────────────────────────

let entA, employeA, adminA, congeTypeA;
let entSuper, superAdmin;
let entB, employeB;

let tokenSuper, tokenAdminA, tokenEmployeB;

beforeAll(async () => {
  const hash = await bcrypt.hash('Test1234!', 10);

  // Entreprise A (contient l'employé dont le congé sera modifié)
  entA = await Entreprise.create({
    nom: `SAUpdate_A_${TS}`, politique_conges: {}, parametres: {}, statut: 'active',
  });
  employeA = await Utilisateur.create({
    entreprise_id: entA.id, prenom: 'Emp', nom: `A44`,
    email: `emp.a44.${TS}@test.internal`,
    role: 'employe', password_hash: hash, statut: 'actif',
  });
  adminA = await Utilisateur.create({
    entreprise_id: entA.id, prenom: 'Adm', nom: `A44`,
    email: `adm.a44.${TS}@test.internal`,
    role: 'admin_entreprise', password_hash: hash, statut: 'actif',
  });
  congeTypeA = await CongeType.create({
    entreprise_id: entA.id,
    libelle: `CP_A44_${TS}`,
    code: `SA${String(TS).slice(-6)}`,
    deductible: true, demi_journee_autorisee: true,
  });
  await CompteurConges.create({
    entreprise_id: entA.id, utilisateur_id: employeA.id,
    conge_type_id: congeTypeA.id, annee: YEAR,
    jours_acquis: 20, jours_reserves: 5, jours_pris: 0,
  });

  // Entreprise Super (isolée, différente de A)
  entSuper = await Entreprise.create({
    nom: `SAUpdate_Super_${TS}`, politique_conges: {}, parametres: {}, statut: 'active',
  });
  superAdmin = await Utilisateur.create({
    entreprise_id: entSuper.id, prenom: 'Super', nom: `Admin44`,
    email: `super.44.${TS}@test.internal`,
    role: 'super_admin', password_hash: hash, statut: 'actif',
  });

  // Entreprise B (employe qui ne doit pas accéder aux congés de A)
  entB = await Entreprise.create({
    nom: `SAUpdate_B_${TS}`, politique_conges: {}, parametres: {}, statut: 'active',
  });
  employeB = await Utilisateur.create({
    entreprise_id: entB.id, prenom: 'Emp', nom: `B44`,
    email: `emp.b44.${TS}@test.internal`,
    role: 'employe', password_hash: hash, statut: 'actif',
  });

  tokenSuper   = generateToken(superAdmin);
  tokenAdminA  = generateToken(adminA);
  tokenEmployeB = generateToken(employeB);
});

afterAll(async () => {
  const ids = [entA?.id, entSuper?.id, entB?.id].filter(Boolean);
  await Entreprise.destroy({ where: { id: ids } }).catch(() => {});
});

// Helper : crée un congé en_attente_manager pour employeA
async function mkCongeA() {
  return Conge.create({
    entreprise_id: entA.id,
    utilisateur_id: employeA.id,
    conge_type_id: congeTypeA.id,
    date_debut: `${YEAR}-11-03`,
    date_fin:   `${YEAR}-11-07`,
    debut_demi_journee: 'matin',
    fin_demi_journee: 'apres_midi',
    statut: 'en_attente_manager',
    jours_calcules: 5,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// A) super_admin modifie le congé d'un employé d'une autre entreprise
// ─────────────────────────────────────────────────────────────────────────────

describe('Fix #44 — super_admin peut modifier le congé de n\'importe quel employé', () => {

  let conge, res;

  beforeAll(async () => {
    conge = await mkCongeA();
    res = await request(app)
      .put(`/api/conges/${conge.id}`)
      .set('Authorization', `Bearer ${tokenSuper}`)
      .send({ commentaire_employe: 'Correction super_admin fix44' });
  });

  afterAll(async () => {
    await Conge.destroy({ where: { id: conge.id } }).catch(() => {});
  });

  it('AVANT fix : 400 « Modification non autorisée » / APRÈS fix : 200', () => {
    expect(res.status).toBe(200);
  });

  it('le commentaire admin est bien enregistré', async () => {
    const updated = await Conge.findByPk(conge.id);
    // super_admin → commentaire_admin (même logique que admin_entreprise)
    expect(updated.commentaire_admin).toBe('Correction super_admin fix44');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B) admin_entreprise de la même entreprise → non-régression
// ─────────────────────────────────────────────────────────────────────────────

describe('Fix #44 — admin_entreprise : non-régression', () => {

  let conge, res;

  beforeAll(async () => {
    conge = await mkCongeA();
    res = await request(app)
      .put(`/api/conges/${conge.id}`)
      .set('Authorization', `Bearer ${tokenAdminA}`)
      .send({ commentaire_employe: 'Correction admin_A fix44' });
  });

  afterAll(async () => {
    await Conge.destroy({ where: { id: conge.id } }).catch(() => {});
  });

  it('répond 200', () => {
    expect(res.status).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C) employe d'une autre entreprise → toujours bloqué (isolation inchangée)
// ─────────────────────────────────────────────────────────────────────────────

describe('Fix #44 — employe d\'une autre entreprise : isolation préservée', () => {

  let conge, res;

  beforeAll(async () => {
    conge = await mkCongeA();
    res = await request(app)
      .put(`/api/conges/${conge.id}`)
      .set('Authorization', `Bearer ${tokenEmployeB}`)
      .send({ commentaire_employe: 'Tentative de modification cross-entreprise' });
  });

  afterAll(async () => {
    await Conge.destroy({ where: { id: conge.id } }).catch(() => {});
  });

  it('répond 400 ou 403 (modification non autorisée)', () => {
    expect([400, 403]).toContain(res.status);
  });

  it('le congé n\'est pas modifié', async () => {
    const c = await Conge.findByPk(conge.id);
    expect(c.commentaire_admin).toBeNull();
    expect(c.commentaire_employe).toBeNull();
  });
});
