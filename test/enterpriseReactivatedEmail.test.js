'use strict';
/**
 * enterpriseReactivatedEmail.test.js
 *
 * Vérifie que sendEnterpriseReactivated est envoyé aux admins de l'entreprise
 * lors du passage suspendue → active, et qu'il n'est pas envoyé lors d'autres
 * transitions.
 *
 * Cas testés :
 *   A) suspendue → active → sendEnterpriseReactivated appelé pour chaque admin actif
 *   B) active → active (no-op) → sendEnterpriseReactivated NON appelé
 *   C) inactive → active → sendEnterpriseReactivated NON appelé (seul suspendue → active déclenche l'email)
 *   D) non-régression : suspendue → suspendue → sendEnterpriseSuspended NON rappelé
 */

const request      = require('supertest');
const app          = require('../src/index');
const emailService = require('../src/services/emailService');
const { Entreprise, Utilisateur } = require('../src/models');
const { generateToken } = require('./helpers/auth');

const suffix = String(Date.now()).slice(-6);

let superAdmin, entreprise, adminA, adminB;

beforeAll(async () => {
  // Entreprise en premier — entreprise_id NOT NULL sur Utilisateur
  entreprise = await Entreprise.create({
    nom: `ReactTest_${suffix}`,
    politique_conges: {},
    parametres: {},
    statut: 'active',
  });

  superAdmin = await Utilisateur.create({
    prenom: 'Super', nom: 'Admin',
    email: `super.entreaact.${suffix}@test.local`,
    role: 'super_admin', password_hash: 'hash', statut: 'actif',
    entreprise_id: entreprise.id,
  });

  adminA = await Utilisateur.create({
    entreprise_id: entreprise.id,
    prenom: 'AdminA', nom: 'React',
    email: `admin.a.react.${suffix}@test.local`,
    role: 'admin_entreprise', password_hash: 'hash', statut: 'actif',
  });

  adminB = await Utilisateur.create({
    entreprise_id: entreprise.id,
    prenom: 'AdminB', nom: 'React',
    email: `admin.b.react.${suffix}@test.local`,
    role: 'admin_entreprise', password_hash: 'hash', statut: 'actif',
  });
});

afterAll(async () => {
  await Utilisateur.destroy({ where: { id: [adminA.id, adminB.id] } });
  await Entreprise.destroy({ where: { id: entreprise.id } });
  await Utilisateur.destroy({ where: { id: superAdmin.id } });
});

const token = () => generateToken(superAdmin);

// ─── CAS A : suspendue → active → email envoyé à chaque admin ────────────────

describe('CAS A — suspendue → active → sendEnterpriseReactivated pour chaque admin', () => {
  let spy;

  beforeAll(async () => {
    await entreprise.update({ statut: 'suspendue' });
    spy = jest.spyOn(emailService, 'sendEnterpriseReactivated').mockResolvedValue(undefined);

    await request(app)
      .patch(`/api/entreprises/${entreprise.id}/statut`)
      .set('Authorization', `Bearer ${token()}`)
      .send({ statut: 'active' });
  });

  afterAll(() => spy.mockRestore());

  it('sendEnterpriseReactivated est appelé autant de fois qu\'il y a d\'admins actifs', () => {
    expect(spy).toHaveBeenCalledTimes(2); // adminA + adminB
  });

  it('chaque appel reçoit un admin de l\'entreprise', () => {
    const destinataires = spy.mock.calls.map(([admin]) => admin.email);
    expect(destinataires).toContain(adminA.email);
    expect(destinataires).toContain(adminB.email);
  });

  it('chaque appel reçoit l\'entreprise avec le bon nom', () => {
    spy.mock.calls.forEach(([, ent]) => {
      expect(ent.nom).toBe(entreprise.nom);
    });
  });
});

// ─── CAS B : active → active (no-op) → pas d'email ──────────────────────────

describe('CAS B — active → active → sendEnterpriseReactivated NON appelé', () => {
  let spy;

  beforeAll(async () => {
    await entreprise.update({ statut: 'active' });
    spy = jest.spyOn(emailService, 'sendEnterpriseReactivated').mockResolvedValue(undefined);

    await request(app)
      .patch(`/api/entreprises/${entreprise.id}/statut`)
      .set('Authorization', `Bearer ${token()}`)
      .send({ statut: 'active' });
  });

  afterAll(() => spy.mockRestore());

  it('sendEnterpriseReactivated n\'est pas appelé', () => {
    expect(spy).not.toHaveBeenCalled();
  });
});

// ─── CAS C : inactive → active → pas d'email (seul suspendue → active compte) ─

describe('CAS C — inactive → active → sendEnterpriseReactivated NON appelé', () => {
  let spy;

  beforeAll(async () => {
    await entreprise.update({ statut: 'inactive' });
    spy = jest.spyOn(emailService, 'sendEnterpriseReactivated').mockResolvedValue(undefined);

    await request(app)
      .patch(`/api/entreprises/${entreprise.id}/statut`)
      .set('Authorization', `Bearer ${token()}`)
      .send({ statut: 'active' });
  });

  afterAll(() => spy.mockRestore());

  it('sendEnterpriseReactivated n\'est pas appelé', () => {
    expect(spy).not.toHaveBeenCalled();
  });
});

// ─── CAS D : non-régression — suspendue → suspendue → sendEnterpriseSuspended NON rappelé ──

describe('CAS D — suspendue → suspendue → sendEnterpriseSuspended NON rappelé', () => {
  let spy;

  beforeAll(async () => {
    await entreprise.update({ statut: 'suspendue' });
    spy = jest.spyOn(emailService, 'sendEnterpriseSuspended').mockResolvedValue(undefined);

    await request(app)
      .patch(`/api/entreprises/${entreprise.id}/statut`)
      .set('Authorization', `Bearer ${token()}`)
      .send({ statut: 'suspendue' });
  });

  afterAll(() => spy.mockRestore());

  it('sendEnterpriseSuspended n\'est pas rappelé (idempotence)', () => {
    expect(spy).not.toHaveBeenCalled();
  });
});
