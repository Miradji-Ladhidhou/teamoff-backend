'use strict';
/**
 * activerReservationWorkflow.test.js — Fix #41
 *
 * POST /api/conges/:id/activate convertit une réservation en congé actif.
 * AVANT fix : statut toujours forcé à 'en_attente_manager', indépendamment
 *             du workflow configuré → un workflow 'auto' est ignoré.
 * APRÈS fix  : workflow 'auto'         → statut 'valide_final' + compteur mis à jour
 *              workflow 'manager_admin' → statut 'en_attente_manager' + compteur inchangé
 *
 * Stratégie : on crée directement un Conge en statut 'reserve' (sans passer
 * par createConge), puis on appelle POST /api/conges/:id/activate.
 */

const request  = require('supertest');
const bcrypt   = require('bcrypt');
const app      = require('../src/index');
const {
  Entreprise, Utilisateur, CongeType, CompteurConges, Conge,
} = require('../src/models');
const { generateToken } = require('./helpers/auth');
const dayjs = require('dayjs');

const TS = Date.now();
const JOURS  = 5;          // jours_calcules de la réservation test
const ACQUIS = 20;         // solde initial du compteur
const CONGE_YEAR = dayjs().year() + 1; // année future pour coller à la sémantique "réservation"

// ─────────────────────────────────────────────────────────────────────────────
// Helpers de création de fixture
// ─────────────────────────────────────────────────────────────────────────────

async function createFixture(label, politiqueConges) {
  const hash = await bcrypt.hash('Test1234!', 10);

  const ent = await Entreprise.create({
    nom: `ActReserv_${label}_${TS}`,
    politique_conges: politiqueConges,
    parametres: {},
    statut: 'active',
  });

  const employe = await Utilisateur.create({
    entreprise_id: ent.id,
    prenom: 'Employe', nom: `${label}41`,
    email: `employe.${label}.41.${TS}@test.internal`,
    role: 'employe', password_hash: hash, statut: 'actif',
  });

  const admin = await Utilisateur.create({
    entreprise_id: ent.id,
    prenom: 'Admin', nom: `${label}41`,
    email: `admin.${label}.41.${TS}@test.internal`,
    role: 'admin_entreprise', password_hash: hash, statut: 'actif',
  });

  const congeType = await CongeType.create({
    entreprise_id: ent.id,
    libelle: `CP_${label}_${TS}`,
    code: `CP${label.slice(0,2).toUpperCase()}${String(TS).slice(-6)}`,
    deductible: true,
    demi_journee_autorisee: true,
  });

  // Compteur avec les jours déjà comptés comme 'reserves' (état d'une réservation)
  const compteur = await CompteurConges.create({
    entreprise_id: ent.id,
    utilisateur_id: employe.id,
    conge_type_id: congeType.id,
    annee: CONGE_YEAR,
    jours_acquis: ACQUIS,
    jours_reserves: JOURS,   // la réservation occupe déjà cette case
    jours_pris: 0,
  });

  // Réservation directement en statut 'reserve'
  const conge = await Conge.create({
    entreprise_id: ent.id,
    utilisateur_id: employe.id,
    conge_type_id: congeType.id,
    date_debut: `${CONGE_YEAR}-08-01`,
    date_fin:   `${CONGE_YEAR}-08-07`,
    debut_demi_journee: 'matin',
    fin_demi_journee: 'apres_midi',
    statut: 'reserve',
    jours_calcules: JOURS,
  });

  return { ent, employe, admin, congeType, compteur, conge,
           tokenAdmin: generateToken(admin) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures globales
// ─────────────────────────────────────────────────────────────────────────────

let fixtureAuto, fixtureManual;

beforeAll(async () => {
  [fixtureAuto, fixtureManual] = await Promise.all([
    createFixture('Auto', { approval_workflow: 'auto' }),
    createFixture('Manual', { approval_workflow: 'manager_admin' }),
  ]);
});

afterAll(async () => {
  const allEntIds = [fixtureAuto?.ent?.id, fixtureManual?.ent?.id].filter(Boolean);
  // La cascade sur Entreprise supprime Utilisateur, Conge, CompteurConges, CongeType
  await Entreprise.destroy({ where: { id: allEntIds } }).catch(() => {});
});

// ─────────────────────────────────────────────────────────────────────────────
// A) Workflow AUTO
// ─────────────────────────────────────────────────────────────────────────────

describe('Fix #41 — activerReservation avec workflow auto', () => {

  let res;
  beforeAll(async () => {
    res = await request(app)
      .post(`/api/conges/${fixtureAuto.conge.id}/activate`)
      .set('Authorization', `Bearer ${fixtureAuto.tokenAdmin}`);
  });

  it('répond 200', () => {
    expect(res.status).toBe(200);
  });

  it('AVANT fix : statut = "en_attente_manager" (incorrect) / APRÈS fix : statut = "valide_final"', async () => {
    const conge = await Conge.findByPk(fixtureAuto.conge.id);
    // AVANT fix : conge.statut === 'en_attente_manager'  ← échoue avant le fix
    // APRÈS fix  : conge.statut === 'valide_final'        ← passe après le fix
    expect(conge.statut).toBe('valide_final');
  });

  it('compteur : jours_reserves décrémenté, jours_acquis décrémenté, jours_pris incrémenté', async () => {
    const compteur = await CompteurConges.findByPk(fixtureAuto.compteur.id);
    expect(Number(compteur.jours_reserves)).toBe(0);            // 5 → 0
    expect(Number(compteur.jours_acquis)).toBe(ACQUIS - JOURS); // 20 → 15
    expect(Number(compteur.jours_pris)).toBe(JOURS);            // 0 → 5
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B) Workflow MANAGER_ADMIN (workflow manuel par défaut)
// ─────────────────────────────────────────────────────────────────────────────

describe('Fix #41 — activerReservation avec workflow manager_admin', () => {

  let res;
  beforeAll(async () => {
    res = await request(app)
      .post(`/api/conges/${fixtureManual.conge.id}/activate`)
      .set('Authorization', `Bearer ${fixtureManual.tokenAdmin}`);
  });

  it('répond 200', () => {
    expect(res.status).toBe(200);
  });

  it('statut = "en_attente_manager" (comportement attendu pour workflow manuel)', async () => {
    const conge = await Conge.findByPk(fixtureManual.conge.id);
    expect(conge.statut).toBe('en_attente_manager');
  });

  it('compteur inchangé : jours restent dans jours_reserves', async () => {
    const compteur = await CompteurConges.findByPk(fixtureManual.compteur.id);
    expect(Number(compteur.jours_reserves)).toBe(JOURS); // 5 → 5 (inchangé)
    expect(Number(compteur.jours_acquis)).toBe(ACQUIS);  // 20 → 20 (inchangé)
    expect(Number(compteur.jours_pris)).toBe(0);         // 0 → 0 (inchangé)
  });
});
