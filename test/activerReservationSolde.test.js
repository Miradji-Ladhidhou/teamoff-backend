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
 *   A) Workflow manuel : activation autorisée sans solde futur, sans débit
 *   B) Solde suffisant : activation autorisée (non-régression)
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

async function mkFixture(label, politiqueConges, jours_acquis, joursConge, createCounter = true) {
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
  if (createCounter) await CompteurConges.create({
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

  return { ent, employe, admin, congeType, conge, tokenAdmin: generateToken(admin) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const JOURS_CONGE = 5;

let fxInsuf, fxSuf, fxNoCounter, fxAutoSplit;

beforeAll(async () => {
  [fxInsuf, fxSuf, fxNoCounter, fxAutoSplit] = await Promise.all([
    // A) solde insuffisant : 3 acquis pour 5 jours demandés
    mkFixture('Insuf', { approval_workflow: 'manager_admin' }, 3, JOURS_CONGE),
    // B) solde suffisant : 20 acquis pour 5 jours demandés
    mkFixture('Suf',   { approval_workflow: 'manager_admin' }, 20, JOURS_CONGE),
    // C) ancienne réservation sans compteur N+1
    mkFixture('NoCounter', { approval_workflow: 'manager_admin' }, 0, JOURS_CONGE, false),
    // D) validation automatique couverte par des années antérieures sans compteur N+1
    mkFixture('AutoSplit', { approval_workflow: 'auto' }, 0, JOURS_CONGE, false),
  ]);
  await Promise.all([
    CompteurConges.create({
      entreprise_id: fxAutoSplit.ent.id,
      utilisateur_id: fxAutoSplit.employe.id,
      conge_type_id: fxAutoSplit.congeType.id,
      annee: CONGE_YEAR - 2,
      jours_acquis: 3,
      jours_pris: 0,
      jours_reserves: 0,
    }),
    CompteurConges.create({
      entreprise_id: fxAutoSplit.ent.id,
      utilisateur_id: fxAutoSplit.employe.id,
      conge_type_id: fxAutoSplit.congeType.id,
      annee: CONGE_YEAR - 1,
      jours_acquis: 2,
      jours_pris: 0,
      jours_reserves: 0,
    }),
  ]);
});

afterAll(async () => {
  const ids = [fxInsuf?.ent?.id, fxSuf?.ent?.id, fxNoCounter?.ent?.id, fxAutoSplit?.ent?.id].filter(Boolean);
  await Entreprise.destroy({ where: { id: ids } }).catch(() => {});
});

// ─────────────────────────────────────────────────────────────────────────────
// A) Solde insuffisant → rejet
// ─────────────────────────────────────────────────────────────────────────────

describe('Activation manuelle — solde futur insuffisant : passage en attente sans débit', () => {

  let res;
  beforeAll(async () => {
    res = await request(app)
      .post(`/api/conges/${fxInsuf.conge.id}/activate`)
      .set('Authorization', `Bearer ${fxInsuf.tokenAdmin}`);
  });

  it('répond 200 car l’activation manuelle ne prélève pas le solde', () => {
    expect(res.status).toBe(200);
  });

  it('le statut devient "en_attente_manager"', async () => {
    const conge = await Conge.findByPk(fxInsuf.conge.id);
    expect(conge.statut).toBe('en_attente_manager');
  });

  it('le compteur reste inchangé', async () => {
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

describe('Activation manuelle — compteur de l’année du congé absent', () => {
  it('active la réservation en workflow normal sans exiger le compteur N+1', async () => {
    const res = await request(app)
      .post(`/api/conges/${fxNoCounter.conge.id}/activate`)
      .set('Authorization', `Bearer ${fxNoCounter.tokenAdmin}`);

    expect(res.status).toBe(200);
    const conge = await Conge.findByPk(fxNoCounter.conge.id);
    expect(conge.statut).toBe('en_attente_manager');
    expect(await CompteurConges.count({ where: { utilisateur_id: fxNoCounter.employe.id } })).toBe(0);
  });
});

describe('Activation automatique — soldes antérieurs sans compteur N+1', () => {
  it('valide en imputant du plus ancien au plus récent', async () => {
    const res = await request(app)
      .post(`/api/conges/${fxAutoSplit.conge.id}/activate`)
      .set('Authorization', `Bearer ${fxAutoSplit.tokenAdmin}`);

    expect(res.status).toBe(200);
    const conge = await Conge.findByPk(fxAutoSplit.conge.id);
    const counters = await CompteurConges.findAll({
      where: { utilisateur_id: fxAutoSplit.employe.id },
      order: [['annee', 'ASC']],
    });
    const imputations = await require('../src/models').CongeImputation.findAll({
      where: { conge_id: fxAutoSplit.conge.id },
      order: [['annee', 'ASC']],
    });

    expect(conge.statut).toBe('valide_final');
    expect(counters.map((row) => Number(row.jours_pris))).toEqual([3, 2]);
    expect(imputations.map((row) => [row.annee, Number(row.jours)])).toEqual([
      [CONGE_YEAR - 2, 3],
      [CONGE_YEAR - 1, 2],
    ]);
    expect(await CompteurConges.count({
      where: { utilisateur_id: fxAutoSplit.employe.id, annee: CONGE_YEAR },
    })).toBe(0);
  });
});

