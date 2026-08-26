'use strict';
/**
 * bcryptCostFactor.test.js — Fix #62
 *
 * PROBLÈME :
 *   Tous les bcrypt.hash(..., 10) utilisaient cost 10 (OWASP recommande ≥ 12).
 *
 * CORRECTION :
 *   BCRYPT_COST = 12 défini dans authService.js et réutilisé dans tous les
 *   contrôleurs (usersController, usersImportController, entreprisesController).
 *   Compatibilité ascendante : bcrypt.compare lit le cost dans le hash stocké,
 *   les comptes existants (cost 10) continuent de fonctionner sans migration.
 *
 * TESTS :
 *   A — BCRYPT_COST vaut bien 12
 *   B — un hash généré avec BCRYPT_COST commence par $2b$12$
 *   C — un hash cost 10 préexistant (utilisateur existant) est toujours vérifiable
 *       (compatibilité ascendante garantie par bcrypt)
 *   D — un utilisateur dont le hash est en cost 10 peut se connecter via l'API
 */

const bcrypt  = require('bcrypt');
const request = require('supertest');
const app     = require('../src/index');
const { seed } = require('./helpers/seed');
const { BCRYPT_COST } = require('../src/services/authService');

// ─────────────────────────────────────────────────────────────────────────────
// A — Constante BCRYPT_COST
// ─────────────────────────────────────────────────────────────────────────────
describe('Fix #62 A — BCRYPT_COST vaut 12', () => {
  it('BCRYPT_COST === 12', () => {
    expect(BCRYPT_COST).toBe(12);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B — Les nouveaux hash sont en cost 12
// ─────────────────────────────────────────────────────────────────────────────
describe('Fix #62 B — nouveau hash produit par BCRYPT_COST', () => {
  it('hash débutant par $2b$12$', async () => {
    const hash = await bcrypt.hash('MonPassword123!', BCRYPT_COST);
    expect(hash.startsWith('$2b$12$')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C — Compatibilité ascendante : un hash cost 10 est toujours vérifiable
// ─────────────────────────────────────────────────────────────────────────────
describe('Fix #62 C — bcrypt.compare vérifie nativement un hash cost 10', () => {
  it('hash cost 10 → compare retourne true (pas de migration nécessaire)', async () => {
    const password = 'AncienPassword1!';
    const hash10 = await bcrypt.hash(password, 10);

    // Le hash stocké embarque son propre cost ($2b$10$…)
    expect(hash10.startsWith('$2b$10$')).toBe(true);

    // bcrypt.compare lit le cost dans le hash — aucune information externe requise
    const match = await bcrypt.compare(password, hash10);
    expect(match).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D — Un utilisateur avec hash cost 10 peut toujours se connecter via l'API
// ─────────────────────────────────────────────────────────────────────────────
describe('Fix #62 D — login API avec compte existant (hash cost 10)', () => {
  let ctx;
  const PASSWORD = 'Test1234!';

  beforeAll(async () => {
    // seed() crée ses utilisateurs avec bcrypt.hashSync(password, 10) — exactement
    // le scénario d'un compte existant produit AVANT le passage à cost 12.
    ctx = await seed();
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it('POST /api/auth/login réussit avec un hash cost 10 en base', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: ctx.admin.email, password: PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('token');
  });
});
