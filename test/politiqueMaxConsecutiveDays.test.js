'use strict';
/**
 * politiqueMaxConsecutiveDays.test.js
 *
 * Vérifie que PUT /api/entreprises/:id/politique rejette
 * max_consecutive_days avec des valeurs hors plage [1, 365].
 *
 * AVANT fix : max_consecutive_days: -1 est accepté (200) → congés multi-jours bloqués
 * APRÈS fix  : valeurs ≤ 0 ou > 365 rejetées (400) ; valeurs valides toujours acceptées
 */

const request = require('supertest');
const app = require('../src/index');
const { Entreprise, Utilisateur } = require('../src/models');
const bcrypt = require('bcrypt');
const { generateToken } = require('./helpers/auth');

let entreprise, admin;
const suffix = String(Date.now()).slice(-6);

beforeAll(async () => {
  const hash = await bcrypt.hash('Password1!', 10);

  entreprise = await Entreprise.create({
    nom: 'PolitiqueMaxTest-' + suffix,
    politique_conges: { max_consecutive_days: 30 },
    parametres: {},
  });

  admin = await Utilisateur.create({
    prenom: 'Admin', nom: 'Pol',
    email: `admin.pol.${suffix}@test.local`,
    role: 'admin_entreprise', password_hash: hash, statut: 'actif',
    entreprise_id: entreprise.id,
  });
});

afterAll(async () => {
  if (admin)      await Utilisateur.destroy({ where: { id: admin.id } }).catch(() => {});
  if (entreprise) await Entreprise.destroy({ where: { id: entreprise.id } }).catch(() => {});
});

function putPolitique(token, payload) {
  return request(app)
    .put(`/api/entreprises/${entreprise.id}/politique`)
    .set('Authorization', `Bearer ${token}`)
    .send({ politique_conges: payload });
}

describe('updatePolitiqueConges — validation max_consecutive_days', () => {
  it('accepte max_consecutive_days: -1 actuellement (bug)', async () => {
    const token = generateToken(admin);
    const res = await putPolitique(token, { max_consecutive_days: -1 });

    // AVANT fix : 200 (bug) — APRÈS fix : 400
    expect(res.status).toBe(400);
  });

  it('rejette max_consecutive_days: 0', async () => {
    const token = generateToken(admin);
    const res = await putPolitique(token, { max_consecutive_days: 0 });
    expect(res.status).toBe(400);
  });

  it('rejette max_consecutive_days: 366 (au-dessus du max)', async () => {
    const token = generateToken(admin);
    const res = await putPolitique(token, { max_consecutive_days: 366 });
    expect(res.status).toBe(400);
  });

  it('rejette max_consecutive_days: 1.5 (non-entier)', async () => {
    const token = generateToken(admin);
    const res = await putPolitique(token, { max_consecutive_days: 1.5 });
    expect(res.status).toBe(400);
  });

  it('accepte max_consecutive_days: 1 (borne min)', async () => {
    const token = generateToken(admin);
    const res = await putPolitique(token, { max_consecutive_days: 1 });
    expect(res.status).toBe(200);
    expect(res.body.politique_conges.max_consecutive_days).toBe(1);
  });

  it('accepte max_consecutive_days: 365 (borne max)', async () => {
    const token = generateToken(admin);
    const res = await putPolitique(token, { max_consecutive_days: 365 });
    expect(res.status).toBe(200);
    expect(res.body.politique_conges.max_consecutive_days).toBe(365);
  });

  it('accepte une mise à jour sans max_consecutive_days (champ optionnel)', async () => {
    const token = generateToken(admin);
    const res = await putPolitique(token, { approval_workflow: 'manager_admin' });
    expect(res.status).toBe(200);
  });
});
