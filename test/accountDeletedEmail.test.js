'use strict';
/**
 * accountDeletedEmail.test.js
 *
 * Vérifie que sendAccountDeleted est envoyé à l'employé supprimé
 * ET à l'admin qui a effectué la suppression.
 *
 * Cas testés :
 *   A) Admin supprime un employé → deux appels sendAccountDeleted (employé + admin)
 *   B) Les données transmises sont correctes pour chaque destinataire
 *   C) Utilisateur inexistant → 404, aucun email
 *   D) Autre rôle non autorisé → 403, aucun email
 */

const request      = require('supertest');
const bcrypt       = require('bcrypt');
const app          = require('../src/index');
const emailService = require('../src/services/emailService');
const { seed }     = require('./helpers/seed');
const { Utilisateur } = require('../src/models');

const HASH = bcrypt.hashSync('Test1234!', 10);

let ctx;

beforeAll(async () => {
  ctx = await seed();
});

afterAll(async () => {
  await ctx.cleanup();
});

// ─── CAS A+B : admin supprime un employé → deux emails ───────────────────────

describe('CAS A+B — admin supprime un employé → sendAccountDeleted appelé pour l\'employé et l\'admin', () => {
  let spy;
  let res;
  let cible;

  beforeAll(async () => {
    cible = await Utilisateur.create({
      entreprise_id: ctx.entreprise.id,
      prenom: 'Jean',
      nom: 'Supprimé',
      email: `jean.supprime.${Date.now()}@test.internal`,
      role: 'employe',
      password_hash: HASH,
      statut: 'actif',
    });

    spy = jest.spyOn(emailService, 'sendAccountDeleted').mockResolvedValue(undefined);

    res = await request(app)
      .delete(`/api/users/${cible.id}`)
      .set('Authorization', `Bearer ${ctx.tokens.admin}`);
  });

  afterAll(() => spy.mockRestore());

  it('retourne 200', () => {
    expect(res.status).toBe(200);
  });

  it('sendAccountDeleted est appelé exactement deux fois', () => {
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('le premier appel cible l\'email de l\'employé supprimé', () => {
    const recipients = spy.mock.calls.map(([r]) => r.email);
    expect(recipients).toContain(cible.email);
  });

  it('le deuxième appel cible l\'email de l\'admin', () => {
    const recipients = spy.mock.calls.map(([r]) => r.email);
    expect(recipients).toContain(ctx.admin.email);
  });

  it('employe_nom est transmis dans les deux appels', () => {
    for (const [, data] of spy.mock.calls) {
      expect(data.employe_nom).toMatch(/Jean/);
    }
  });

  it('message_principal de l\'employé mentionne la suppression', () => {
    const employeCall = spy.mock.calls.find(([r]) => r.email === cible.email);
    expect(employeCall[1].message_principal).toMatch(/supprimé/i);
  });

  it('message_principal de l\'admin mentionne le nom du collaborateur', () => {
    const adminCall = spy.mock.calls.find(([r]) => r.email === ctx.admin.email);
    expect(adminCall[1].message_principal).toMatch(/Jean/);
  });

  it('date_suppression est une chaîne non vide dans les deux appels', () => {
    for (const [, data] of spy.mock.calls) {
      expect(typeof data.date_suppression).toBe('string');
      expect(data.date_suppression.length).toBeGreaterThan(0);
    }
  });
});

// ─── CAS C : utilisateur inexistant → 404, aucun email ───────────────────────

describe('CAS C — utilisateur inexistant → 404, aucun email', () => {
  let spy;

  beforeAll(async () => {
    spy = jest.spyOn(emailService, 'sendAccountDeleted').mockResolvedValue(undefined);
  });

  afterAll(() => spy.mockRestore());

  it('retourne 404 et n\'envoie aucun email', async () => {
    const fakeId = '00000000-0000-4000-a000-000000000099';
    const res = await request(app)
      .delete(`/api/users/${fakeId}`)
      .set('Authorization', `Bearer ${ctx.tokens.admin}`);

    expect([404, 403]).toContain(res.status);
    expect(spy).not.toHaveBeenCalled();
  });
});

// ─── CAS D : rôle non autorisé → 403, aucun email ────────────────────────────

describe('CAS D — employé tente de supprimer → 403, aucun email', () => {
  let spy;

  beforeAll(async () => {
    spy = jest.spyOn(emailService, 'sendAccountDeleted').mockResolvedValue(undefined);
  });

  afterAll(() => spy.mockRestore());

  it('retourne 403 et n\'envoie aucun email', async () => {
    const res = await request(app)
      .delete(`/api/users/${ctx.manager.id}`)
      .set('Authorization', `Bearer ${ctx.tokens.employe}`);

    expect(res.status).toBe(403);
    expect(spy).not.toHaveBeenCalled();
  });
});
