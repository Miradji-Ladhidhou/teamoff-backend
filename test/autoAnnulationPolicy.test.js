'use strict';
/**
 * autoAnnulationPolicy.test.js — Fix #43
 *
 * La politique allow_employee_cancel_own_pending / allow_manager_cancel_own_pending
 * est stockée dans entreprise.politique_conges et vérifiée côté UI.
 * AVANT fix : un appel API direct contourne la restriction (DELETE réussit).
 * APRÈS fix  : le serveur relit la politique et rejette (403) si la config l'interdit.
 *
 * Cas couverts :
 *   A) employe tente d'annuler sa demande en attente, politique interdit → 403
 *   B) employe peut annuler quand politique l'autorise               → 200 (non-régression)
 *   C) manager tente d'annuler sa propre demande, politique interdit → 403
 *   D) admin_entreprise peut toujours annuler, quelle que soit la politique → 200
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
const YEAR = dayjs().year();

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function mkConge(ent, user, congeType) {
  const [compteur] = await CompteurConges.findOrCreate({
    where: {
      entreprise_id: ent.id,
      utilisateur_id: user.id,
      conge_type_id: congeType.id,
      annee: YEAR,
    },
    defaults: { jours_acquis: 20, jours_reserves: 5, jours_pris: 0 },
  });
  // Réinitialiser à chaque appel pour un état prévisible
  await compteur.update({ jours_acquis: 20, jours_reserves: 5, jours_pris: 0 });

  return Conge.create({
    entreprise_id: ent.id,
    utilisateur_id: user.id,
    conge_type_id: congeType.id,
    date_debut: `${YEAR}-10-01`,
    date_fin:   `${YEAR}-10-05`,
    debut_demi_journee: 'matin',
    fin_demi_journee: 'apres_midi',
    statut: 'en_attente_manager',
    jours_calcules: 5,
  });
}

async function mkFixture(label, politiqueConges) {
  const hash = await bcrypt.hash('Test1234!', 10);

  const ent = await Entreprise.create({
    nom: `AutoAnnu_${label}_${TS}`,
    politique_conges: politiqueConges,
    parametres: {},
    statut: 'active',
  });

  const employe = await Utilisateur.create({
    entreprise_id: ent.id, prenom: 'Emp', nom: `${label}43`,
    email: `emp.${label}.43.${TS}@test.internal`,
    role: 'employe', password_hash: hash, statut: 'actif',
  });

  const manager = await Utilisateur.create({
    entreprise_id: ent.id, prenom: 'Mgr', nom: `${label}43`,
    email: `mgr.${label}.43.${TS}@test.internal`,
    role: 'manager', password_hash: hash, statut: 'actif',
  });

  const admin = await Utilisateur.create({
    entreprise_id: ent.id, prenom: 'Adm', nom: `${label}43`,
    email: `adm.${label}.43.${TS}@test.internal`,
    role: 'admin_entreprise', password_hash: hash, statut: 'actif',
  });

  const congeType = await CongeType.create({
    entreprise_id: ent.id,
    libelle: `CP_${label}_${TS}`,
    code: `A${label.slice(0,2).toUpperCase()}${String(TS).slice(-6)}`,
    deductible: true,
    demi_journee_autorisee: true,
  });

  return {
    ent, employe, manager, admin, congeType,
    tokenEmploye: generateToken(employe),
    tokenManager: generateToken(manager),
    tokenAdmin:   generateToken(admin),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

let fxBlock, fxAllow, fxMgrBlock;

beforeAll(async () => {
  [fxBlock, fxAllow, fxMgrBlock] = await Promise.all([
    // A) employe bloqué
    mkFixture('Block', {
      allow_employee_cancel_own_pending: false,
      allow_manager_cancel_own_pending: true,
    }),
    // B) employe autorisé (défaut)
    mkFixture('Allow', {
      allow_employee_cancel_own_pending: true,
      allow_manager_cancel_own_pending: true,
    }),
    // C+D) manager bloqué mais admin toujours libre
    mkFixture('MgrBlk', {
      allow_employee_cancel_own_pending: true,
      allow_manager_cancel_own_pending: false,
    }),
  ]);
});

afterAll(async () => {
  const ids = [fxBlock?.ent?.id, fxAllow?.ent?.id, fxMgrBlock?.ent?.id].filter(Boolean);
  await Entreprise.destroy({ where: { id: ids } }).catch(() => {});
});

// ─────────────────────────────────────────────────────────────────────────────
// A) employe bloqué par la politique
// ─────────────────────────────────────────────────────────────────────────────

describe('Fix #43 — employe bloqué par allow_employee_cancel_own_pending=false', () => {

  let conge, res;

  beforeAll(async () => {
    conge = await mkConge(fxBlock.ent, fxBlock.employe, fxBlock.congeType);
    res = await request(app)
      .delete(`/api/conges/${conge.id}`)
      .set('Authorization', `Bearer ${fxBlock.tokenEmploye}`);
  });

  it('AVANT fix : 200 (bypass) / APRÈS fix : 403', () => {
    expect(res.status).toBe(403);
  });

  it('message d\'erreur explicite', () => {
    const msg = (res.body?.message || '').toLowerCase();
    expect(msg).toMatch(/politique|autoris|interdit|pending|annul/i);
  });

  it('le congé reste en_attente_manager', async () => {
    const c = await Conge.findByPk(conge.id);
    expect(c.statut).toBe('en_attente_manager');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B) employe autorisé par la politique (non-régression)
// ─────────────────────────────────────────────────────────────────────────────

describe('Fix #43 — employe autorisé : annulation fonctionne', () => {

  let conge, res;

  beforeAll(async () => {
    conge = await mkConge(fxAllow.ent, fxAllow.employe, fxAllow.congeType);
    res = await request(app)
      .delete(`/api/conges/${conge.id}`)
      .set('Authorization', `Bearer ${fxAllow.tokenEmploye}`);
  });

  it('répond 204', () => {
    expect(res.status).toBe(204);
  });

  it('le congé est supprimé', async () => {
    const c = await Conge.findByPk(conge.id);
    expect(c).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C) manager bloqué par la politique pour sa propre demande
// ─────────────────────────────────────────────────────────────────────────────

describe('Fix #43 — manager bloqué par allow_manager_cancel_own_pending=false', () => {

  let conge, res;

  beforeAll(async () => {
    conge = await mkConge(fxMgrBlock.ent, fxMgrBlock.manager, fxMgrBlock.congeType);
    res = await request(app)
      .delete(`/api/conges/${conge.id}`)
      .set('Authorization', `Bearer ${fxMgrBlock.tokenManager}`);
  });

  it('AVANT fix : 200 (bypass) / APRÈS fix : 403', () => {
    expect(res.status).toBe(403);
  });

  it('le congé reste en_attente_manager (non supprimé)', async () => {
    const c = await Conge.findByPk(conge.id);
    // AVANT fix : c est null (supprimé). APRÈS fix : c existe et son statut est inchangé.
    expect(c).not.toBeNull();
    expect(c?.statut).toBe('en_attente_manager');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D) admin_entreprise : toujours autorisé, quelle que soit la politique
// ─────────────────────────────────────────────────────────────────────────────

describe('Fix #43 — admin_entreprise : immunité totale à la politique', () => {

  let conge, res;

  beforeAll(async () => {
    // Utilise fxBlock (politique la plus restrictive pour les employés)
    conge = await mkConge(fxBlock.ent, fxBlock.employe, fxBlock.congeType);
    res = await request(app)
      .delete(`/api/conges/${conge.id}`)
      .set('Authorization', `Bearer ${fxBlock.tokenAdmin}`);
  });

  it('répond 204 même avec allow_employee_cancel_own_pending=false', () => {
    expect(res.status).toBe(204);
  });

  it('le congé est supprimé', async () => {
    const c = await Conge.findByPk(conge.id);
    expect(c).toBeNull();
  });
});
