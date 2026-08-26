'use strict';
/**
 * accountDeactivatedEmail.test.js
 *
 * Vérifie que sendAccountDeactivated est appelé quand un admin désactive
 * un utilisateur (statut → 'inactif'), et qu'il n'est PAS appelé dans les
 * cas où la désactivation ne devrait pas déclencher d'email.
 *
 * Cas testés :
 *   A) Admin désactive un employé actif → sendAccountDeactivated appelé
 *   B) Admin désactive un employé déjà inactif → sendAccountDeactivated NON appelé (idempotence)
 *   C) Admin réactive un employé (statut → actif) → sendAccountDeactivated NON appelé
 *      (c'est sendAccountReactivated qui doit l'être — non-régression)
 */

const request      = require('supertest');
const app          = require('../src/index');
const emailService = require('../src/services/emailService');
const { seed }     = require('./helpers/seed');
const { Utilisateur } = require('../src/models');

let ctx;
let target; // employé cobaye

beforeAll(async () => {
  ctx = await seed();

  // Crée un employé dédié à ce test pour ne pas perturber les autres
  target = await Utilisateur.create({
    entreprise_id: ctx.entreprise.id,
    prenom: 'Cible', nom: 'Deactivation',
    email: `deactivation.target.${Date.now()}@test.local`,
    role: 'employe',
    service: 'Dev',
    password_hash: 'hash',
    statut: 'actif',
  });
});

afterAll(async () => {
  await Utilisateur.destroy({ where: { id: target.id } }).catch(() => {});
  await ctx.cleanup();
});

// ─── CAS A : Désactivation d'un compte actif ─────────────────────────────────

describe('CAS A — désactivation compte actif → email envoyé', () => {
  let spy;

  beforeAll(async () => {
    await target.update({ statut: 'actif' }); // état de départ garanti
    spy = jest.spyOn(emailService, 'sendAccountDeactivated').mockResolvedValue(undefined);

    await request(app)
      .put(`/api/users/${target.id}`)
      .set('Authorization', `Bearer ${ctx.tokens.admin}`)
      .send({ statut: 'inactif' });
  });

  afterAll(() => spy.mockRestore());

  it('sendAccountDeactivated est appelé une fois', () => {
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('le destinataire est l\'utilisateur désactivé', () => {
    const [utilisateur] = spy.mock.calls[0];
    expect(utilisateur.id).toBe(target.id);
  });
});

// ─── CAS B : Désactivation idempotente (déjà inactif) ───────────────────────

describe('CAS B — compte déjà inactif → email NON envoyé', () => {
  let spy;

  beforeAll(async () => {
    await target.update({ statut: 'inactif' }); // état de départ : déjà inactif
    spy = jest.spyOn(emailService, 'sendAccountDeactivated').mockResolvedValue(undefined);

    await request(app)
      .put(`/api/users/${target.id}`)
      .set('Authorization', `Bearer ${ctx.tokens.admin}`)
      .send({ statut: 'inactif' });
  });

  afterAll(() => spy.mockRestore());

  it('sendAccountDeactivated n\'est pas appelé', () => {
    expect(spy).not.toHaveBeenCalled();
  });
});

// ─── CAS C : Réactivation → sendAccountDeactivated NON appelé ───────────────

describe('CAS C — réactivation → sendAccountDeactivated NON appelé (non-régression)', () => {
  let spyDeactivated;
  let spyReactivated;

  beforeAll(async () => {
    await target.update({ statut: 'inactif' }); // état de départ : inactif
    spyDeactivated = jest.spyOn(emailService, 'sendAccountDeactivated').mockResolvedValue(undefined);
    spyReactivated = jest.spyOn(emailService, 'sendAccountReactivated').mockResolvedValue(undefined);

    await request(app)
      .put(`/api/users/${target.id}`)
      .set('Authorization', `Bearer ${ctx.tokens.admin}`)
      .send({ statut: 'actif' });
  });

  afterAll(() => {
    spyDeactivated.mockRestore();
    spyReactivated.mockRestore();
  });

  it('sendAccountDeactivated n\'est pas appelé', () => {
    expect(spyDeactivated).not.toHaveBeenCalled();
  });

  it('sendAccountReactivated est bien appelé (non-régression)', () => {
    expect(spyReactivated).toHaveBeenCalledTimes(1);
  });
});
