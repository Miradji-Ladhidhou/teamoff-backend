'use strict';
/**
 * roleChangedEmail.test.js
 *
 * Vérifie que sendRoleChanged est appelé quand le rôle d'un utilisateur change,
 * via les deux routes qui permettent cette modification.
 *
 * Cas testés :
 *   A) PUT /:id (updateUser) — admin change employe → manager → email envoyé
 *   B) PUT /:id (updateUser) — même rôle → email NON envoyé (no-op)
 *   C) PUT /:id/role (changeUserRole) — super_admin change manager → employe → email envoyé
 *   D) sendRoleChanged reçoit l'ancien et le nouveau rôle dans le bon ordre
 */

const request      = require('supertest');
const app          = require('../src/index');
const emailService = require('../src/services/emailService');
const { seed }     = require('./helpers/seed');
const { Utilisateur } = require('../src/models');

let ctx;
let target; // utilisateur cobaye

beforeAll(async () => {
  ctx = await seed();

  target = await Utilisateur.create({
    entreprise_id: ctx.entreprise.id,
    prenom: 'Cible', nom: 'RoleChange',
    email: `role.change.${Date.now()}@test.local`,
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

// ─── CAS A : updateUser — rôle différent → email envoyé ─────────────────────

describe('CAS A — PUT /:id avec nouveau rôle → sendRoleChanged appelé', () => {
  let spy;

  beforeAll(async () => {
    await target.update({ role: 'employe' }); // état de départ garanti
    spy = jest.spyOn(emailService, 'sendRoleChanged').mockResolvedValue(undefined);

    await request(app)
      .put(`/api/users/${target.id}`)
      .set('Authorization', `Bearer ${ctx.tokens.admin}`)
      .send({ role: 'manager' }); // pas de service dans le body : le check d'existence ne se déclenche pas
  });

  afterAll(() => spy.mockRestore());

  it('sendRoleChanged est appelé une fois', () => {
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('reçoit l\'utilisateur, l\'ancien rôle et le nouveau rôle', () => {
    const [utilisateur, ancienRole, nouveauRole] = spy.mock.calls[0];
    expect(utilisateur.id).toBe(target.id);
    expect(ancienRole).toBe('employe');
    expect(nouveauRole).toBe('manager');
  });
});

// ─── CAS B : updateUser — même rôle → email NON envoyé ──────────────────────

describe('CAS B — PUT /:id avec même rôle → sendRoleChanged NON appelé', () => {
  let spy;

  beforeAll(async () => {
    await target.update({ role: 'manager' }); // état de départ
    spy = jest.spyOn(emailService, 'sendRoleChanged').mockResolvedValue(undefined);

    await request(app)
      .put(`/api/users/${target.id}`)
      .set('Authorization', `Bearer ${ctx.tokens.admin}`)
      .send({ role: 'manager' }); // même rôle
  });

  afterAll(() => spy.mockRestore());

  it('sendRoleChanged n\'est pas appelé', () => {
    expect(spy).not.toHaveBeenCalled();
  });
});

// ─── CAS C : changeUserRole — super_admin → email envoyé ────────────────────

describe('CAS C — PUT /:id/role (super_admin) → sendRoleChanged appelé', () => {
  let spy;

  beforeAll(async () => {
    await target.update({ role: 'manager' }); // état de départ
    spy = jest.spyOn(emailService, 'sendRoleChanged').mockResolvedValue(undefined);

    await request(app)
      .put(`/api/users/${target.id}/role`)
      .set('Authorization', `Bearer ${ctx.tokens.superAdmin}`)
      .send({ role: 'employe' });
  });

  afterAll(() => spy.mockRestore());

  it('sendRoleChanged est appelé une fois', () => {
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('reçoit l\'ancien rôle manager et le nouveau rôle employe', () => {
    const [utilisateur, ancienRole, nouveauRole] = spy.mock.calls[0];
    expect(utilisateur.id).toBe(target.id);
    expect(ancienRole).toBe('manager');
    expect(nouveauRole).toBe('employe');
  });
});
