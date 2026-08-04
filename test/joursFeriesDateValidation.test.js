'use strict';
/**
 * joursFeriesDateValidation.test.js — Fix #59
 *
 * POST /api/jours-feries et PUT /api/jours-feries/:id acceptent une date
 * quelconque sans validation de format : "not-a-date" provoque un crash
 * Sequelize/PostgreSQL qui se traduit par un 500 au lieu d'un 400.
 *
 * AVANT fix : date invalide → 500.
 * APRÈS fix  : date invalide → 400 avec message clair.
 *
 * Cas testés :
 *   A) POST  avec date="not-a-date"   → 400
 *   B) POST  avec date="2024-13-45"   → 400 (mois invalide)
 *   C) POST  avec date="2025-06-15"   → 201 (non-régression)
 *   D) PUT   avec date="not-a-date"   → 400
 *   E) PUT   avec date="2025-07-14"   → 200 (non-régression)
 */

const request = require('supertest');
const app = require('../src/index');
const { seed } = require('./helpers/seed');
const { JoursFeries } = require('../src/models');

const TS = Date.now();
let ctx, jourFerieId;

beforeAll(async () => {
  ctx = await seed();

  // Créer un jour férié valide pour les tests PUT
  const jf = await JoursFeries.create({
    entreprise_id: ctx.entreprise.id,
    date: '2025-05-01',
    libelle: 'Fête du travail test #59',
    recurrent: true,
    est_travail: false,
  });
  jourFerieId = jf.id;
});

afterAll(async () => {
  await JoursFeries.destroy({ where: { entreprise_id: ctx.entreprise.id } });
  await ctx.cleanup();
});

// ─────────────────────────────────────────────────────────────────────────────
// A) POST — date="not-a-date" → 400
// ─────────────────────────────────────────────────────────────────────────────

describe('Fix #59 A — POST avec date invalide texte → 400', () => {
  it('not-a-date provoque un 400 (et non un 500)', async () => {
    const res = await request(app)
      .post('/api/jours-feries')
      .set('Authorization', `Bearer ${ctx.tokens.admin}`)
      .send({
        date: 'not-a-date',
        libelle: 'Test invalide',
        recurrent: false,
        est_travail: false,
      });

    expect(res.status).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B) POST — date="2024-13-45" → 400 (mois/jour hors plage)
// ─────────────────────────────────────────────────────────────────────────────

describe('Fix #59 B — POST avec date hors plage → 400', () => {
  it('2024-13-45 provoque un 400', async () => {
    const res = await request(app)
      .post('/api/jours-feries')
      .set('Authorization', `Bearer ${ctx.tokens.admin}`)
      .send({
        date: '2024-13-45',
        libelle: 'Test hors plage',
        recurrent: false,
        est_travail: false,
      });

    expect(res.status).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C) POST — date valide → 201 (non-régression)
// ─────────────────────────────────────────────────────────────────────────────

describe('Fix #59 C — POST avec date valide → 201', () => {
  it('date YYYY-MM-DD correcte acceptée (non-régression)', async () => {
    const res = await request(app)
      .post('/api/jours-feries')
      .set('Authorization', `Bearer ${ctx.tokens.admin}`)
      .send({
        date: `2025-06-${String(TS).slice(-2).replace(/[^0-2]/, '1') || '10'}`,
        libelle: `Jour test valide ${TS}`,
        recurrent: false,
        est_travail: false,
      });

    // 201 créé ou 409 si date déjà prise — les deux prouvent que la validation passe
    expect([201, 409]).toContain(res.status);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D) PUT — date="not-a-date" → 400
// ─────────────────────────────────────────────────────────────────────────────

describe('Fix #59 D — PUT avec date invalide → 400', () => {
  it('not-a-date dans la modification provoque un 400', async () => {
    const res = await request(app)
      .put(`/api/jours-feries/${jourFerieId}`)
      .set('Authorization', `Bearer ${ctx.tokens.admin}`)
      .send({
        date: 'not-a-date',
        libelle: 'Modif invalide',
        recurrent: false,
        est_travail: false,
      });

    expect(res.status).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E) PUT — date valide → 200 (non-régression)
// ─────────────────────────────────────────────────────────────────────────────

describe('Fix #59 E — PUT avec date valide → 200', () => {
  it('date YYYY-MM-DD correcte acceptée à la modification', async () => {
    const res = await request(app)
      .put(`/api/jours-feries/${jourFerieId}`)
      .set('Authorization', `Bearer ${ctx.tokens.admin}`)
      .send({
        date: '2025-05-01',
        libelle: 'Fête du travail modifiée',
        recurrent: true,
        est_travail: false,
      });

    expect(res.status).toBe(200);
  });
});
