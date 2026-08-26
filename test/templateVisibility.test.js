'use strict';
/**
 * templateVisibility.test.js — Fix #39
 *
 * GET /jours-feries/templates expose tous les templates de toutes les entreprises
 * à un admin_entreprise qui ne devrait voir que les siens + les globaux.
 *
 * AVANT fix : where = {} → retourne TOUT.
 * APRÈS fix  : admin_entreprise → source_entreprise_id IN (son_id, null).
 *              super_admin       → tout.
 */

const request  = require('supertest');
const bcrypt   = require('bcrypt');
const app      = require('../src/index');
const {
  Entreprise, Utilisateur, HolidayTemplate,
} = require('../src/models');
const { generateToken } = require('./helpers/auth');

const TS = Date.now();

let entA, adminA, tokenA;
let entB, adminB, tokenB;
let superEnt, superAdmin, tokenSuper;

let tplA, tplB, tplGlobal;

beforeAll(async () => {
  const hash = await bcrypt.hash('Test1234!', 10);

  // Entreprise A
  entA = await Entreprise.create({
    nom: `TplVis_A_${TS}`, politique_conges: {}, parametres: {}, statut: 'active',
  });
  adminA = await Utilisateur.create({
    entreprise_id: entA.id, prenom: 'Admin', nom: 'A39',
    email: `admin.a39.${TS}@test.internal`,
    role: 'admin_entreprise', password_hash: hash, statut: 'actif',
  });
  tokenA = generateToken(adminA);

  // Entreprise B (autre entreprise)
  entB = await Entreprise.create({
    nom: `TplVis_B_${TS}`, politique_conges: {}, parametres: {}, statut: 'active',
  });
  adminB = await Utilisateur.create({
    entreprise_id: entB.id, prenom: 'Admin', nom: 'B39',
    email: `admin.b39.${TS}@test.internal`,
    role: 'admin_entreprise', password_hash: hash, statut: 'actif',
  });
  tokenB = generateToken(adminB);

  // Super admin
  superEnt = await Entreprise.create({
    nom: `TplVis_Super_${TS}`, politique_conges: {}, parametres: {}, statut: 'active',
  });
  superAdmin = await Utilisateur.create({
    entreprise_id: superEnt.id, prenom: 'Super', nom: 'Admin39',
    email: `super.39.${TS}@test.internal`,
    role: 'super_admin', password_hash: hash, statut: 'actif',
  });
  tokenSuper = generateToken(superAdmin);

  // Template appartenant à l'entreprise A
  tplA = await HolidayTemplate.create({
    name: `TplA_${TS}`,
    country_code: 'FR',
    source_entreprise_id: entA.id,
    created_by: adminA.id,
  });

  // Template appartenant à l'entreprise B
  tplB = await HolidayTemplate.create({
    name: `TplB_${TS}`,
    country_code: 'FR',
    source_entreprise_id: entB.id,
    created_by: adminB.id,
  });

  // Template global (source_entreprise_id = null) — ex : template national importé
  tplGlobal = await HolidayTemplate.create({
    name: `TplGlobal_${TS}`,
    country_code: 'FR',
    source_entreprise_id: null,
    created_by: null,
  });
});

afterAll(async () => {
  await HolidayTemplate.destroy({
    where: { id: [tplA?.id, tplB?.id, tplGlobal?.id].filter(Boolean) },
  }).catch(() => {});
  await Utilisateur.destroy({
    where: { id: [adminA?.id, adminB?.id, superAdmin?.id].filter(Boolean) },
  }).catch(() => {});
  await Entreprise.destroy({
    where: { id: [entA?.id, entB?.id, superEnt?.id].filter(Boolean) },
  }).catch(() => {});
});

// Helper : extrait les IDs des templates retournés
const ids = (body) => (Array.isArray(body) ? body.map((t) => t.id) : []);

describe('Fix #39 — Visibilité des templates par entreprise', () => {

  describe('admin_entreprise A', () => {
    it('AVANT fix : reçoit aussi le template de l\'entreprise B (fuite de données)', async () => {
      const res = await request(app)
        .get('/api/jours-feries/templates')
        .set('Authorization', `Bearer ${tokenA}`);

      expect(res.status).toBe(200);

      // AVANT fix : tplB.id EST dans la réponse → isolation absente
      // APRÈS fix  : tplB.id ne doit PAS être dans la réponse
      const returnedIds = ids(res.body);
      expect(returnedIds).toContain(tplA.id);      // son propre template
      expect(returnedIds).toContain(tplGlobal.id); // template global partagé
      expect(returnedIds).not.toContain(tplB.id);  // template d'une autre entreprise
    });
  });

  describe('admin_entreprise B', () => {
    it('ne voit que son template + le global, pas le template de A', async () => {
      const res = await request(app)
        .get('/api/jours-feries/templates')
        .set('Authorization', `Bearer ${tokenB}`);

      expect(res.status).toBe(200);
      const returnedIds = ids(res.body);
      expect(returnedIds).toContain(tplB.id);
      expect(returnedIds).toContain(tplGlobal.id);
      expect(returnedIds).not.toContain(tplA.id);
    });
  });

  describe('super_admin', () => {
    it('voit tous les templates (A + B + global)', async () => {
      const res = await request(app)
        .get('/api/jours-feries/templates')
        .set('Authorization', `Bearer ${tokenSuper}`);

      expect(res.status).toBe(200);
      const returnedIds = ids(res.body);
      expect(returnedIds).toContain(tplA.id);
      expect(returnedIds).toContain(tplB.id);
      expect(returnedIds).toContain(tplGlobal.id);
    });
  });
});
