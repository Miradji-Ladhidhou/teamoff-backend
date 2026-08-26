'use strict';
/**
 * absenceDelete.test.js — Fix #66
 *
 * PROBLÈME :
 *   routes/absences.js n'expose aucune route DELETE.
 *   Un employé ne peut pas corriger une absence saisie par erreur
 *   et un admin ne peut pas la supprimer via l'API.
 *
 * CORRECTION :
 *   DELETE /api/absences/:id avec règles d'autorisation :
 *     - Employé    : uniquement la sienne, si statut === 'signalée'
 *     - Manager    : toute absence de son entreprise
 *     - Admin      : toute absence de son entreprise
 *     - super_admin: toute absence (cross-entreprise)
 *
 * TESTS :
 *   A — l'employé supprime sa propre absence 'signalée' → 204
 *   B — l'employé tente de supprimer une absence déjà 'approuvée' → 409
 *   C — l'employé tente de supprimer l'absence d'un collègue → 403
 *   D — le manager supprime une absence de son entreprise → 204
 *   E — ID inconnu → 404
 */

const request  = require('supertest');
const app      = require('../src/index');
const { seed } = require('./helpers/seed');
const { Absence } = require('../src/models');

let ctx;

beforeAll(async () => {
  ctx = await seed();
});

afterAll(async () => {
  await ctx.cleanup();
});

// Helper : crée une absence en base avec le statut voulu
async function makeAbsence(utilisateur_id, entreprise_id, statut = 'signalée') {
  const absence = await Absence.create({
    utilisateur_id,
    entreprise_id,
    type_absence: 'absence_exceptionnelle',
    date_debut:   '2025-01-10',
    date_fin:     '2025-01-10',
    commentaire:  'Test absence',
    statut,
  });
  return absence;
}

// ─────────────────────────────────────────────────────────────────────────────
// A — Employé supprime sa propre absence 'signalée' → 204
// ─────────────────────────────────────────────────────────────────────────────
describe('Fix #66 A — employé supprime sa propre absence signalée', () => {
  it('DELETE /api/absences/:id → 204', async () => {
    const absence = await makeAbsence(ctx.employe.id, ctx.entreprise.id, 'signalée');

    const res = await request(app)
      .delete(`/api/absences/${absence.id}`)
      .set('Authorization', `Bearer ${ctx.tokens.employe}`);

    expect(res.status).toBe(204);

    // Vérifie que la ligne est réellement supprimée en base
    const inDb = await Absence.findByPk(absence.id);
    expect(inDb).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B — Employé tente de supprimer une absence déjà 'approuvée' → 409
// ─────────────────────────────────────────────────────────────────────────────
describe('Fix #66 B — employé ne peut pas supprimer une absence approuvée', () => {
  let absence;

  beforeAll(async () => {
    absence = await makeAbsence(ctx.employe.id, ctx.entreprise.id, 'approuvée');
  });

  afterAll(async () => {
    if (absence) await absence.destroy().catch(() => {});
  });

  it('DELETE /api/absences/:id → 409 (déjà traitée)', async () => {
    const res = await request(app)
      .delete(`/api/absences/${absence.id}`)
      .set('Authorization', `Bearer ${ctx.tokens.employe}`);

    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/approuvée|rejetée/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C — Employé tente de supprimer l'absence d'un collègue → 403
// ─────────────────────────────────────────────────────────────────────────────
describe("Fix #66 C — employé ne peut pas supprimer l'absence d'un collègue", () => {
  let absence;

  beforeAll(async () => {
    // L'absence appartient au manager, pas à l'employé
    absence = await makeAbsence(ctx.manager.id, ctx.entreprise.id, 'signalée');
  });

  afterAll(async () => {
    if (absence) await absence.destroy().catch(() => {});
  });

  it('DELETE /api/absences/:id → 403', async () => {
    const res = await request(app)
      .delete(`/api/absences/${absence.id}`)
      .set('Authorization', `Bearer ${ctx.tokens.employe}`);

    expect(res.status).toBe(403);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D — Manager supprime une absence 'approuvée' de son entreprise → 204
// ─────────────────────────────────────────────────────────────────────────────
describe("Fix #66 D — manager supprime une absence approuvée de son entreprise", () => {
  it('DELETE /api/absences/:id → 204', async () => {
    const absence = await makeAbsence(ctx.employe.id, ctx.entreprise.id, 'approuvée');

    const res = await request(app)
      .delete(`/api/absences/${absence.id}`)
      .set('Authorization', `Bearer ${ctx.tokens.manager}`);

    expect(res.status).toBe(204);

    const inDb = await Absence.findByPk(absence.id);
    expect(inDb).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E — ID inconnu → 404
// ─────────────────────────────────────────────────────────────────────────────
describe('Fix #66 E — absence inexistante → 404', () => {
  it('DELETE /api/absences/:id avec UUID inconnu → 404', async () => {
    // UUID v4 valide syntaxiquement mais inexistant en base
    const res = await request(app)
      .delete('/api/absences/f47ac10b-58cc-4372-a567-0e02b2c3d479')
      .set('Authorization', `Bearer ${ctx.tokens.admin}`);

    expect(res.status).toBe(404);
  });
});
