'use strict';
/**
 * profileUpdateRateLimit.test.js — Fix #64
 *
 * PROBLÈME :
 *   PUT /me utilisait advancedRateLimiter('login') : 10 req/min par user,
 *   conçu pour bloquer les brute-force de login.
 *   Trop restrictif pour une mise à jour de profil (auto-save, multi-onglets).
 *
 * CORRECTION :
 *   Nouveau limiter 'profileUpdate' : 30 req/min / burst 40 / block 10s.
 *   Adapté à une route authentifiée non-sécuritaire.
 *
 * TESTS :
 *   A — la config 'profileUpdate' existe et est plus permissive que 'login'
 *   B — PUT /me répond 200 avec des données valides (non-régression)
 *   C — 12 requêtes consécutives passent toutes (échouaient avec 'login' à 10/min)
 */

const request  = require('supertest');
const app      = require('../src/index');
const { seed } = require('./helpers/seed');
const rateLimitConfig = require('../src/config/rateLimitConfig');

let ctx;

beforeAll(async () => {
  ctx = await seed();
});

afterAll(async () => {
  await ctx.cleanup();
});

// ─────────────────────────────────────────────────────────────────────────────
// A — La config 'profileUpdate' existe et est plus permissive que 'login'
// ─────────────────────────────────────────────────────────────────────────────
describe('Fix #64 A — config profileUpdate plus permissive que login', () => {
  it('profileUpdate est défini dans rateLimitConfig', () => {
    const { profileUpdate } = rateLimitConfig.endpoints;
    expect(profileUpdate).toBeDefined();
    expect(profileUpdate.points).toBeDefined();
    expect(profileUpdate.duration).toBeDefined();
  });

  it('profileUpdate.points > login.points (au moins 3× plus permissif)', () => {
    const { profileUpdate, login } = rateLimitConfig.endpoints;
    expect(profileUpdate.points).toBeGreaterThan(login.points);
    // login = 10/min → profile doit permettre au minimum 30/min
    expect(profileUpdate.points).toBeGreaterThanOrEqual(30);
  });

  it('profileUpdate.blockDuration <= login.blockDuration (blocage court)', () => {
    const { profileUpdate, login } = rateLimitConfig.endpoints;
    // Un utilisateur qui dépasse la limite de profil ne doit pas être bloqué aussi longtemps
    expect(profileUpdate.blockDuration).toBeLessThanOrEqual(login.blockDuration);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B — PUT /me répond 200 avec des données valides
// ─────────────────────────────────────────────────────────────────────────────
describe('Fix #64 B — PUT /me fonctionne normalement', () => {
  it('mise à jour de profil réussit → 200', async () => {
    const res = await request(app)
      .put('/api/me')
      .set('Authorization', `Bearer ${ctx.tokens.admin}`)
      .send({ prenom: 'Admin', nom: 'Test' });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('prenom', 'Admin');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C — 12 requêtes successives passent (échouaient avec login limiter à 10/min)
//     Avec 'login' (points=10, burst=15) : la 11e requête était susceptible
//     d'être bloquée. Avec 'profileUpdate' (points=30, burst=40) : aucun blocage.
// ─────────────────────────────────────────────────────────────────────────────
describe('Fix #64 C — 12 requêtes rapides acceptées (utilisable normalement)', () => {
  it('12 PUT /me successifs ne retournent aucun 429', async () => {
    const statuses = [];
    for (let i = 0; i < 12; i++) {
      const res = await request(app)
        .put('/api/me')
        .set('Authorization', `Bearer ${ctx.tokens.manager}`)
        .send({ prenom: 'Manager', nom: `Test ${i}` });
      statuses.push(res.status);
    }

    // Toutes les requêtes doivent réussir (200) — aucun 429
    expect(statuses.every(s => s === 200)).toBe(true);
    expect(statuses).not.toContain(429);
  });
});
