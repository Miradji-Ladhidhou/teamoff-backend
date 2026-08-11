'use strict';
/**
 * emailChangedNotification.test.js
 *
 * Vérifie que sendEmailChanged est envoyé à l'ANCIENNE adresse email
 * quand l'adresse email d'un compte est modifiée.
 *
 * Cas testés :
 *   A) Admin change l'email d'un employé → sendEmailChanged appelé vers l'ancienne adresse
 *   B) Utilisateur change son propre email → sendEmailChanged appelé vers l'ancienne adresse
 *   C) Admin met à jour le nom (sans changer l'email) → sendEmailChanged NON appelé
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

// ─── CAS A : admin change l'email d'un employé ───────────────────────────────

describe('CAS A — admin change l\'email d\'un employé → sendEmailChanged vers ancienne adresse', () => {
  let spy;
  let cible;
  const oldEmail = `old.email.${Date.now()}@test.internal`;
  const newEmail = `new.email.${Date.now()}@test.internal`;

  beforeAll(async () => {
    cible = await Utilisateur.create({
      entreprise_id: ctx.entreprise.id,
      prenom: 'Jean',
      nom: 'Dupont',
      email: oldEmail,
      role: 'employe',
      password_hash: HASH,
      statut: 'actif',
      service: ctx.employe.service || 'RH',
    });

    spy = jest.spyOn(emailService, 'sendEmailChanged').mockResolvedValue(undefined);

    await request(app)
      .put(`/api/users/${cible.id}`)
      .set('Authorization', `Bearer ${ctx.tokens.admin}`)
      .send({ email: newEmail });
  });

  afterAll(async () => {
    spy.mockRestore();
    await Utilisateur.destroy({ where: { id: cible.id } });
  });

  it('sendEmailChanged est appelé une fois', () => {
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('le destinataire est l\'ancienne adresse email', () => {
    const [recipient] = spy.mock.calls[0];
    expect(recipient.email).toBe(oldEmail);
  });

  it('ancienne et nouvelle adresses sont transmises', () => {
    const [, { oldEmail: old, newEmail: nw }] = spy.mock.calls[0];
    expect(old).toBe(oldEmail);
    expect(nw).toBe(newEmail);
  });
});

// ─── CAS B : utilisateur change son propre email ─────────────────────────────

describe('CAS B — utilisateur change son propre email → sendEmailChanged vers ancienne adresse', () => {
  let spy;
  let cible;
  let cibleToken;
  const oldEmail = `self.old.${Date.now()}@test.internal`;
  const newEmail = `self.new.${Date.now()}@test.internal`;

  beforeAll(async () => {
    const { generateToken } = require('./helpers/auth');
    cible = await Utilisateur.create({
      entreprise_id: ctx.entreprise.id,
      prenom: 'Marie',
      nom: 'Martin',
      email: oldEmail,
      role: 'employe',
      password_hash: HASH,
      statut: 'actif',
      service: ctx.employe.service || 'RH',
    });
    cibleToken = generateToken(cible);

    spy = jest.spyOn(emailService, 'sendEmailChanged').mockResolvedValue(undefined);

    await request(app)
      .put('/api/me')
      .set('Authorization', `Bearer ${cibleToken}`)
      .send({ email: newEmail, currentPassword: 'Test1234!' });
  });

  afterAll(async () => {
    spy.mockRestore();
    await Utilisateur.destroy({ where: { id: cible.id } });
  });

  it('sendEmailChanged est appelé une fois', () => {
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('le destinataire est l\'ancienne adresse email', () => {
    const [recipient] = spy.mock.calls[0];
    expect(recipient.email).toBe(oldEmail);
  });
});

// ─── CAS C : changement de nom sans email → NON appelé ───────────────────────

describe('CAS C — admin change le nom sans toucher l\'email → sendEmailChanged NON appelé', () => {
  let spy;

  beforeAll(async () => {
    spy = jest.spyOn(emailService, 'sendEmailChanged').mockResolvedValue(undefined);

    await request(app)
      .put(`/api/users/${ctx.employe.id}`)
      .set('Authorization', `Bearer ${ctx.tokens.admin}`)
      .send({ nom: 'NouveauNom' });
  });

  afterAll(() => spy.mockRestore());

  it('sendEmailChanged n\'est pas appelé', () => {
    expect(spy).not.toHaveBeenCalled();
  });
});
