'use strict';
/**
 * activerReservationSolde.test.js — Fix #42
 *
 * activerReservation ne vérifiait pas le solde : si les jours_acquis couvrent
 * partiellement les jours demandés, le déficit est absorbé silencieusement
 * (Math.max(0, …) dans les mises à jour de compteur).
 *
 * AVANT fix : POST /api/conges/:id/activate → 200, statut change, compteur corrompu.
 * APRÈS fix  : POST /api/conges/:id/activate → 400 avec message explicite.
 *
 * Deux cas :
 *   A) Solde insuffisant (jours_acquis < jours_reserves)  → 400 attendu
 *   B) Solde suffisant                                     → 200 attendu (non-régression)
 */

const request = require('supertest');
const bcrypt  = require('bcrypt');
const app     = require('../src/index');
const {
  Entreprise, Utilisateur, CongeType, CompteurConges, Conge,
} = require('../src/models');
const { generateToken } = require('./helpers/auth');
const dayjs = require('dayjs');

const TS = Date.now();
const CONGE_YEAR = dayjs().year() + 1;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function mkFixture(label, politiqueConges, jours_acquis, joursConge) {
  const hash = await bcrypt.hash('Test1234!', 10);

  const ent = await Entreprise.create({
    nom: `ActSolde_${label}_${TS}`,
    politique_conges: politiqueConges,
    parametres: {},
    statut: 'active',
  });

  const employe = await Utilisateur.create({
    entreprise_id: ent.id,
    prenom: 'Emp', nom: `${label}42`,
    email: `emp.${label}.42.${TS}@test.internal`,
    role: 'employe', password_hash: hash, statut: 'actif',
  });

  const admin = await Utilisateur.create({
    entreprise_id: ent.id,
    prenom: 'Adm', nom: `${label}42`,
    email: `adm.${label}.42.${TS}@test.internal`,
    role: 'admin_entreprise', password_hash: hash, statut: 'actif',
  });

  const congeType = await CongeType.create({
    entreprise_id: ent.id,
    libelle: `CP_${label}_${TS}`,
    code: `S${label.slice(0,2).toUpperCase()}${String(TS).slice(-6)}`,
    deductible: true,
    demi_journee_autorisee: true,
  });

  // jours_reserves = joursConge : la réservation est déjà comptée dans ce bucket
  await CompteurConges.create({
    entreprise_id: ent.id,
    utilisateur_id: employe.id,
    conge_type_id: congeType.id,
    annee: CONGE_YEAR,
    jours_acquis: jours_acquis,
    jours_reserves: joursConge,
    jours_pris: 0,
  });

  const conge = await Conge.create({
    entreprise_id: ent.id,
    utilisateur_id: employe.id,
    conge_type_id: congeType.id,
    date_debut: `${CONGE_YEAR}-09-01`,
    date_fin:   `${CONGE_YEAR}-09-05`,
    debut_demi_journee: 'matin',
    fin_demi_journee: 'apres_midi',
    statut: 'reserve',
    jours_calcules: joursConge,
  });

  return { ent, employe, admin, conge, tokenAdmin: generateToken(admin) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const JOURS_CONGE = 5;

let fxInsuf, fxSuf;

beforeAll(async () => {
  [fxInsuf, fxSuf] = await Promise.all([
    // A) solde insuffisant : 3 acquis pour 5 jours demandés
    mkFixture('Insuf', { approval_workflow: 'manager_admin' }, 3, JOURS_CONGE),
    // B) solde suffisant : 20 acquis pour 5 jours demandés
    mkFixture('Suf',   { approval_workflow: 'manager_admin' }, 20, JOURS_CONGE),
  ]);
});

afterAll(async () => {
  const ids = [fxInsuf?.ent?.id, fxSuf?.ent?.id].filter(Boolean);
  await Entreprise.destroy({ where: { id: ids } }).catch(() => {});
});

// ─────────────────────────────────────────────────────────────────────────────
// A) Solde insuffisant → rejet
// ─────────────────────────────────────────────────────────────────────────────

describe('Fix #42 — solde insuffisant : activation refusée', () => {

  let res;
  beforeAll(async () => {
    res = await request(app)
      .post(`/api/conges/${fxInsuf.conge.id}/activate`)
      .set('Authorization', `Bearer ${fxInsuf.tokenAdmin}`);
  });

  it('AVANT fix : 200 (déficit absorbé silencieusement) / APRÈS fix : 400', () => {
    expect(res.status).toBe(400);
  });

  it('message d\'erreur explicite mentionnant le solde', () => {
    const msg = (res.body?.message || res.body?.error || '').toLowerCase();
    expect(msg).toMatch(/solde|insuffisant|disponible/i);
  });

  it('le statut du congé reste "reserve" (non modifié)', async () => {
    const conge = await Conge.findByPk(fxInsuf.conge.id);
    expect(conge.statut).toBe('reserve');
  });

  it('le compteur n\'est pas modifié', async () => {
    const compteur = await CompteurConges.findOne({
      where: {
        utilisateur_id: fxInsuf.employe.id,
        conge_type_id: fxInsuf.conge.conge_type_id,
        annee: CONGE_YEAR,
      },
    });
    expect(Number(compteur.jours_acquis)).toBe(3);    // inchangé
    expect(Number(compteur.jours_reserves)).toBe(JOURS_CONGE); // inchangé
    expect(Number(compteur.jours_pris)).toBe(0);      // inchangé
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B) Solde suffisant → succès (non-régression)
// ─────────────────────────────────────────────────────────────────────────────

describe('Fix #42 — solde suffisant : activation autorisée', () => {

  let res;
  beforeAll(async () => {
    res = await request(app)
      .post(`/api/conges/${fxSuf.conge.id}/activate`)
      .set('Authorization', `Bearer ${fxSuf.tokenAdmin}`);
  });

  it('répond 200', () => {
    expect(res.status).toBe(200);
  });

  it('statut = "en_attente_manager"', async () => {
    const conge = await Conge.findByPk(fxSuf.conge.id);
    expect(conge.statut).toBe('en_attente_manager');
  });
});

