'use strict';
/**
 * serviceChangedEmail.test.js
 *
 * Vérifie que sendServiceChanged est envoyé à l'employé
 * quand son service est modifié par un admin.
 *
 * Cas testés :
 *   A) Admin change le service d'un employé → sendServiceChanged appelé
 *   B) Admin change le nom (sans toucher le service) → sendServiceChanged NON appelé
 *   C) Admin met à jour le service avec la même valeur → sendServiceChanged NON appelé
 */

const request      = require('supertest');
const bcrypt       = require('bcrypt');
const app          = require('../src/index');
const emailService = require('../src/services/emailService');
const { seed }     = require('./helpers/seed');
const { Utilisateur, Entreprise } = require('../src/models');

const HASH = bcrypt.hashSync('Test1234!', 10);

let ctx;

beforeAll(async () => {
  ctx = await seed();
});

afterAll(async () => {
  await ctx.cleanup();
});

// ─── CAS A : admin change le service → sendServiceChanged appelé ─────────────

describe('CAS A — admin change le service d\'un employé → sendServiceChanged appelé', () => {
  let spy;
  let cible;

  beforeAll(async () => {
    // serviceExistsInEntreprise vérifie politique_conges.service_policies —
    // on patch l'entreprise pour que IT et RH soient valides.
    await Entreprise.update(
      { politique_conges: { service_policies: { IT: {}, RH: {} } } },
      { where: { id: ctx.entreprise.id } }
    );

    cible = await Utilisateur.create({
      entreprise_id: ctx.entreprise.id,
      prenom: 'Pierre',
      nom: 'Dupont',
      email: `svc.change.${Date.now()}@test.internal`,
      role: 'employe',
      password_hash: HASH,
      statut: 'actif',
      service: 'IT',
    });

    spy = jest.spyOn(emailService, 'sendServiceChanged').mockResolvedValue(undefined);

    await request(app)
      .put(`/api/users/${cible.id}`)
      .set('Authorization', `Bearer ${ctx.tokens.admin}`)
      .send({ service: 'RH' });
  });

  afterAll(async () => {
    spy.mockRestore();
    await Utilisateur.destroy({ where: { id: cible.id } });
    // Restaurer la politique originale
    await Entreprise.update(
      { politique_conges: {} },
      { where: { id: ctx.entreprise.id } }
    );
  });

  it('sendServiceChanged est appelé une fois', () => {
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('l\'employé est le destinataire', () => {
    const [utilisateur] = spy.mock.calls[0];
    expect(utilisateur.id).toBe(cible.id);
  });

  it('ancien et nouveau service sont transmis', () => {
    const [, ancienService, nouveauService] = spy.mock.calls[0];
    expect(typeof ancienService).toBe('string');
    expect(typeof nouveauService).toBe('string');
    expect(ancienService).not.toBe(nouveauService);
  });
});

// ─── CAS B : changement de nom → sendServiceChanged NON appelé ───────────────

describe('CAS B — admin change le nom sans toucher le service → sendServiceChanged NON appelé', () => {
  let spy;

  beforeAll(async () => {
    spy = jest.spyOn(emailService, 'sendServiceChanged').mockResolvedValue(undefined);

    await request(app)
      .put(`/api/users/${ctx.employe.id}`)
      .set('Authorization', `Bearer ${ctx.tokens.admin}`)
      .send({ nom: 'NomInchangé' });
  });

  afterAll(() => spy.mockRestore());

  it('sendServiceChanged n\'est pas appelé', () => {
    expect(spy).not.toHaveBeenCalled();
  });
});
