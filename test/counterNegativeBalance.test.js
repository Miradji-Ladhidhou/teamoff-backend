'use strict';
/**
 * counterNegativeBalance.test.js — Fix #32
 *
 * jours_acquis doit être >= 0.
 * AVANT fix : jours_acquis: -50 accepté → employé bloqué définitivement.
 * APRÈS fix  : 422 avec message d'erreur explicite.
 * Les autres champs (jours_pris, jours_reportes, jours_reserves) ont déjà
 * un Math.max(0, …) dans normalizeCounterPayload — on vérifie qu'ils sont
 * aussi rejetés explicitement par le validateur.
 */

const request  = require('supertest');
const bcrypt   = require('bcrypt');
const app      = require('../src/index');
const {
  Entreprise, Utilisateur, CongeType, CompteurConges,
} = require('../src/models');
const { generateToken } = require('./helpers/auth');

let entreprise, employe, admin, congeType, tokenAdmin;

beforeAll(async () => {
  const hash = await bcrypt.hash('Test1234!', 10);

  entreprise = await Entreprise.create({
    nom: 'NegBalance ' + Date.now(),
    politique_conges: {},
    parametres: {},
    statut: 'active',
  });

  employe = await Utilisateur.create({
    entreprise_id: entreprise.id,
    prenom: 'Emp', nom: 'NegBal32',
    email: `emp.nb32.${Date.now()}@test.internal`,
    role: 'employe', password_hash: hash, statut: 'actif',
  });

  admin = await Utilisateur.create({
    entreprise_id: entreprise.id,
    prenom: 'Adm', nom: 'NegBal32',
    email: `adm.nb32.${Date.now()}@test.internal`,
    role: 'admin_entreprise', password_hash: hash, statut: 'actif',
  });

  congeType = await CongeType.create({
    entreprise_id: entreprise.id,
    code: 'CP32', libelle: 'Congés payés 32',
    quota_annuel: 25, demi_journee_autorisee: true,
  });

  tokenAdmin = generateToken(admin);
});

afterAll(async () => {
  await CompteurConges.destroy({ where: { entreprise_id: entreprise.id } });
  await CongeType.destroy({ where: { entreprise_id: entreprise.id } });
  await Utilisateur.destroy({ where: { entreprise_id: entreprise.id } });
  await Entreprise.destroy({ where: { id: entreprise.id } });
});

describe('Fix #32 — jours_acquis doit être >= 0', () => {
  it('jours_acquis: -50 → 422 (AVANT fix : était 200)', async () => {
    const res = await request(app)
      .post(`/api/quotas/counters/${employe.id}`)
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({
        conge_type_id: congeType.id,
        annee: 2027,
        jours_acquis: -50,
      });

    expect(res.status).toBe(422);
  });

  it('jours_pris: -5 → 422', async () => {
    const res = await request(app)
      .post(`/api/quotas/counters/${employe.id}`)
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({
        conge_type_id: congeType.id,
        annee: 2027,
        jours_acquis: 10,
        jours_pris: -5,
      });

    expect(res.status).toBe(422);
  });

  it('jours_reportes: -3 → 422', async () => {
    const res = await request(app)
      .post(`/api/quotas/counters/${employe.id}`)
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({
        conge_type_id: congeType.id,
        annee: 2027,
        jours_acquis: 10,
        jours_reportes: -3,
      });

    expect(res.status).toBe(422);
  });

  it('valeurs valides → 200', async () => {
    const res = await request(app)
      .post(`/api/quotas/counters/${employe.id}`)
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({
        conge_type_id: congeType.id,
        annee: 2027,
        jours_acquis: 15,
        jours_pris: 2,
        jours_reportes: 1,
      });

    expect(res.status).toBe(200);
    expect(Number(res.body.item.jours_acquis)).toBe(15);
  });

  it('jours_acquis: 0 → 200 (borne exacte autorisée)', async () => {
    const res = await request(app)
      .post(`/api/quotas/counters/${employe.id}`)
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({
        conge_type_id: congeType.id,
        annee: 2027,
        jours_acquis: 0,
      });

    expect(res.status).toBe(200);
  });
});
