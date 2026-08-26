'use strict';
/**
 * userEmailValidation.test.js — Fix #56
 *
 * createUserRules et updateUserRules n'appellent pas .isEmail() :
 * des adresses malformées sont acceptées et stockées, puis utilisées
 * dans les emails d'invitation.
 *
 * AVANT fix : POST/PUT avec email="not-an-email" retourne 201/200.
 * APRÈS fix  : email malformé retourne 422 ; les adresses valides passent toujours.
 *
 * Cas testés :
 *   A) POST /api/users   — email malformé → 422
 *   B) POST /api/users   — email valide   → 201 (non-régression création)
 *   C) PUT  /api/users/:id — email malformé → 422
 *   D) PUT  /api/users/:id — email valide   → 200 (non-régression update)
 */

const request = require('supertest');
const app = require('../src/index');
const { seed } = require('./helpers/seed');

const TS = Date.now();

let ctx;

beforeAll(async () => {
  ctx = await seed();
});

afterAll(async () => {
  await ctx.cleanup();
});

// ─────────────────────────────────────────────────────────────────────────────
// A) POST — email malformé rejeté
// ─────────────────────────────────────────────────────────────────────────────

describe('Fix #56 A — POST /api/users avec email malformé → 422', () => {
  const malformedEmails = [
    'not-an-email',
    'missing@tld',
    '@nodomain.com',
    'spaces in@email.com',
    '',
  ];

  for (const badEmail of malformedEmails) {
    it(`email "${badEmail}" est rejeté (422)`, async () => {
      const res = await request(app)
        .post('/api/users')
        .set('Authorization', `Bearer ${ctx.tokens.superAdmin}`)
        .send({
          nom: 'Test',
          prenom: 'EmailBad',
          email: badEmail,
          role: 'manager',          // manager ne requiert pas de service
          entreprise_id: ctx.entreprise.id,
        });

      expect(res.status).toBe(422);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// B) POST — email valide accepté (non-régression)
// ─────────────────────────────────────────────────────────────────────────────

describe('Fix #56 B — POST /api/users avec email valide → 201', () => {
  it('email valide accepté à la création', async () => {
    const res = await request(app)
      .post('/api/users')
      .set('Authorization', `Bearer ${ctx.tokens.superAdmin}`)
      .send({
        nom: 'Valid',
        prenom: 'Email',
        email: `valid.email.56.${TS}@example.com`,
        role: 'manager',            // manager ne requiert pas de service
        entreprise_id: ctx.entreprise.id,
      });

    expect(res.status).toBe(201);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C) PUT — email malformé rejeté
// ─────────────────────────────────────────────────────────────────────────────

// ctx.admin est admin_entreprise — aucun service requis, pas de conflit de service.
describe('Fix #56 C — PUT /api/users/:id avec email malformé → 422', () => {
  it('email "bad@@address" est rejeté à la modification (422)', async () => {
    const res = await request(app)
      .put(`/api/users/${ctx.admin.id}`)
      .set('Authorization', `Bearer ${ctx.tokens.superAdmin}`)
      .send({ email: 'bad@@address' });

    expect(res.status).toBe(422);
  });

  it('email "nodot@" est rejeté à la modification (422)', async () => {
    const res = await request(app)
      .put(`/api/users/${ctx.admin.id}`)
      .set('Authorization', `Bearer ${ctx.tokens.superAdmin}`)
      .send({ email: 'nodot@' });

    expect(res.status).toBe(422);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D) PUT — email valide accepté (non-régression)
// ─────────────────────────────────────────────────────────────────────────────

describe('Fix #56 D — PUT /api/users/:id avec email valide → 200', () => {
  it('email valide accepté à la modification', async () => {
    const res = await request(app)
      .put(`/api/users/${ctx.admin.id}`)
      .set('Authorization', `Bearer ${ctx.tokens.superAdmin}`)
      .send({ email: `updated.valid.56.${TS}@example.com` });

    expect(res.status).toBe(200);
  });
});
