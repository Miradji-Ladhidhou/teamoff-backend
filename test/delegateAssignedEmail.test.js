'use strict';
/**
 * delegateAssignedEmail.test.js
 *
 * Vérifie que sendDelegateAssigned est envoyé au délégué lors de la
 * désignation via PUT /:id/delegate, et qu'il n'est pas envoyé lors
 * de la suppression de la délégation (delegue_id: null).
 *
 * Cas testés :
 *   A) Désignation d'un délégué → sendDelegateAssigned appelé avec le bon délégué et le bon manager
 *   B) Suppression de la délégation (delegue_id: null) → sendDelegateAssigned NON appelé
 *   C) Remplacement du délégué → sendDelegateAssigned appelé avec le nouveau délégué
 */

const request      = require('supertest');
const app          = require('../src/index');
const emailService = require('../src/services/emailService');
const { Entreprise, Utilisateur } = require('../src/models');
const { generateToken } = require('./helpers/auth');

const suffix = String(Date.now()).slice(-6);

let entreprise, admin, manager, delegueA, delegueB;

beforeAll(async () => {
  entreprise = await Entreprise.create({
    nom: `DelegateTest_${suffix}`,
    politique_conges: {},
    parametres: {},
    statut: 'active',
  });

  admin = await Utilisateur.create({
    entreprise_id: entreprise.id,
    prenom: 'Admin', nom: 'Delegate',
    email: `admin.delegate.${suffix}@test.local`,
    role: 'admin_entreprise', password_hash: 'hash', statut: 'actif',
  });

  manager = await Utilisateur.create({
    entreprise_id: entreprise.id,
    prenom: 'Jean', nom: 'Manager',
    email: `manager.delegate.${suffix}@test.local`,
    role: 'manager', password_hash: 'hash', statut: 'actif',
  });

  delegueA = await Utilisateur.create({
    entreprise_id: entreprise.id,
    prenom: 'Alice', nom: 'Delegue',
    email: `delegue.a.${suffix}@test.local`,
    role: 'manager', password_hash: 'hash', statut: 'actif',
  });

  delegueB = await Utilisateur.create({
    entreprise_id: entreprise.id,
    prenom: 'Bob', nom: 'Delegue',
    email: `delegue.b.${suffix}@test.local`,
    role: 'manager', password_hash: 'hash', statut: 'actif',
  });
});

afterAll(async () => {
  await Utilisateur.destroy({ where: { entreprise_id: entreprise.id } });
  await Entreprise.destroy({ where: { id: entreprise.id } });
});

// ─── CAS A : Désignation → email envoyé ──────────────────────────────────────

describe('CAS A — désignation d\'un délégué → sendDelegateAssigned appelé', () => {
  let spy;

  beforeAll(async () => {
    await manager.update({ delegue_id: null }); // état de départ propre
    spy = jest.spyOn(emailService, 'sendDelegateAssigned').mockResolvedValue(undefined);

    await request(app)
      .put(`/api/users/${manager.id}/delegate`)
      .set('Authorization', `Bearer ${generateToken(admin)}`)
      .send({ delegue_id: delegueA.id });
  });

  afterAll(() => spy.mockRestore());

  it('sendDelegateAssigned est appelé une fois', () => {
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('le premier argument est le délégué', () => {
    const [delegue] = spy.mock.calls[0];
    expect(delegue.id).toBe(delegueA.id);
  });

  it('le second argument est le manager délégant', () => {
    const [, managerArg] = spy.mock.calls[0];
    expect(managerArg.id).toBe(manager.id);
  });
});

// ─── CAS B : Suppression (null) → pas d'email ────────────────────────────────

describe('CAS B — suppression de la délégation → sendDelegateAssigned NON appelé', () => {
  let spy;

  beforeAll(async () => {
    await manager.update({ delegue_id: delegueA.id }); // délégation préexistante
    spy = jest.spyOn(emailService, 'sendDelegateAssigned').mockResolvedValue(undefined);

    await request(app)
      .put(`/api/users/${manager.id}/delegate`)
      .set('Authorization', `Bearer ${generateToken(admin)}`)
      .send({ delegue_id: null });
  });

  afterAll(() => spy.mockRestore());

  it('sendDelegateAssigned n\'est pas appelé', () => {
    expect(spy).not.toHaveBeenCalled();
  });
});

// ─── CAS C : Remplacement du délégué → email envoyé au nouveau ───────────────

describe('CAS C — remplacement du délégué → sendDelegateAssigned appelé avec le nouveau', () => {
  let spy;

  beforeAll(async () => {
    await manager.update({ delegue_id: delegueA.id }); // délégué initial
    spy = jest.spyOn(emailService, 'sendDelegateAssigned').mockResolvedValue(undefined);

    await request(app)
      .put(`/api/users/${manager.id}/delegate`)
      .set('Authorization', `Bearer ${generateToken(admin)}`)
      .send({ delegue_id: delegueB.id }); // nouveau délégué
  });

  afterAll(() => spy.mockRestore());

  it('sendDelegateAssigned est appelé une fois', () => {
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('le délégué notifié est le nouveau (delegueB)', () => {
    const [delegue] = spy.mock.calls[0];
    expect(delegue.id).toBe(delegueB.id);
  });
});
