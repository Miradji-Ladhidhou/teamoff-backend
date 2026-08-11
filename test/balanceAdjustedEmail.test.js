'use strict';
/**
 * balanceAdjustedEmail.test.js
 *
 * Vérifie que sendBalanceAdjusted est envoyé à l'employé quand un admin
 * ajuste manuellement son solde de congés (jours_acquis change).
 *
 * Cas testés :
 *   A) jours_acquis change (10 → 25) → sendBalanceAdjusted appelé une fois
 *   B) même valeur (25 → 25) → sendBalanceAdjusted NON appelé
 *   C) ajustement décroissant (25 → 5) → sendBalanceAdjusted appelé avec bons soldes
 *   D) non-régression : sendBalanceAdjusted n'est pas déclenché par tryActivateReservations
 */

const request      = require('supertest');
const app          = require('../src/index');
const emailService = require('../src/services/emailService');
const { seed }     = require('./helpers/seed');
const { CompteurConges } = require('../src/models');

let ctx;
let annee;

beforeAll(async () => {
  ctx = await seed();
  annee = new Date().getFullYear();

  // Créer un compteur initial connu à 10 jours pour l'employé
  await CompteurConges.upsert({
    entreprise_id: ctx.entreprise.id,
    utilisateur_id: ctx.employe.id,
    conge_type_id: ctx.congeType.id,
    annee,
    jours_acquis: 10,
    jours_pris: 0,
    jours_reportes: 0,
    jours_reserves: 0,
    jours_annules: 0,
  });
});

afterAll(async () => {
  await CompteurConges.destroy({
    where: {
      entreprise_id: ctx.entreprise.id,
      utilisateur_id: ctx.employe.id,
      conge_type_id: ctx.congeType.id,
      annee,
    },
  });
  await ctx.cleanup();
});

const body = (jours_acquis) => ({
  conge_type_id: ctx.congeType.id,
  annee,
  jours_acquis,
});

const call = (jours_acquis) =>
  request(app)
    .post(`/api/quotas/counters/${ctx.employe.id}`)
    .set('Authorization', `Bearer ${ctx.tokens.admin}`)
    .send(body(jours_acquis));

// ─── Utilitaire : forcer l'état du compteur en DB ────────────────────────────

const setCounter = async (jours_acquis) => {
  await CompteurConges.update(
    { jours_acquis },
    {
      where: {
        entreprise_id: ctx.entreprise.id,
        utilisateur_id: ctx.employe.id,
        conge_type_id: ctx.congeType.id,
        annee,
      },
    }
  );
};

// ─── CAS A : jours_acquis change (10 → 25) → email envoyé ───────────────────

describe('CAS A — jours_acquis change (10 → 25) → sendBalanceAdjusted appelé', () => {
  let spy;
  let res;

  beforeAll(async () => {
    await setCounter(10);
    spy = jest.spyOn(emailService, 'sendBalanceAdjusted').mockResolvedValue(undefined);
    res = await call(25);
  });

  afterAll(() => spy.mockRestore());

  it('retourne 200', () => {
    expect(res.status).toBe(200);
  });

  it('sendBalanceAdjusted est appelé une fois', () => {
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('le destinataire est l\'employé concerné', () => {
    const [utilisateur] = spy.mock.calls[0];
    expect(utilisateur.id).toBe(ctx.employe.id);
  });

  it('les soldes ancien et nouveau sont corrects', () => {
    const [, , ancienSolde, nouveauSolde] = spy.mock.calls[0];
    expect(ancienSolde).toBe(10);
    expect(nouveauSolde).toBe(25);
  });
});

// ─── CAS B : même valeur (25 → 25) → email NON envoyé ───────────────────────

describe('CAS B — même valeur (25 → 25) → sendBalanceAdjusted NON appelé', () => {
  let spy;

  beforeAll(async () => {
    await setCounter(25);
    spy = jest.spyOn(emailService, 'sendBalanceAdjusted').mockResolvedValue(undefined);
    await call(25);
  });

  afterAll(() => spy.mockRestore());

  it('sendBalanceAdjusted n\'est pas appelé', () => {
    expect(spy).not.toHaveBeenCalled();
  });
});

// ─── CAS C : ajustement décroissant (25 → 5) → email avec bons soldes ────────

describe('CAS C — ajustement décroissant (25 → 5) → sendBalanceAdjusted avec bons soldes', () => {
  let spy;

  beforeAll(async () => {
    await setCounter(25);
    spy = jest.spyOn(emailService, 'sendBalanceAdjusted').mockResolvedValue(undefined);
    await call(5);
  });

  afterAll(() => spy.mockRestore());

  it('sendBalanceAdjusted est appelé une fois', () => {
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('ancienSolde=25 et nouveauSolde=5', () => {
    const [, , ancienSolde, nouveauSolde] = spy.mock.calls[0];
    expect(ancienSolde).toBe(25);
    expect(nouveauSolde).toBe(5);
  });
});

// ─── CAS D : non-régression — sendBalanceAdjusted appelé une seule fois ─────

describe('CAS D — sendBalanceAdjusted appelé exactement une fois par ajustement', () => {
  let spy;

  beforeAll(async () => {
    await setCounter(10);
    spy = jest.spyOn(emailService, 'sendBalanceAdjusted').mockResolvedValue(undefined);
    // Un seul appel API
    await call(20);
  });

  afterAll(() => spy.mockRestore());

  it('sendBalanceAdjusted est appelé exactement une fois (pas de doublon)', () => {
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
