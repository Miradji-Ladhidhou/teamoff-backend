'use strict';
/**
 * updateUserSelfDisable.test.js
 *
 * Vérifie que updateUser refuse :
 *   1. Un admin qui se désactive lui-même
 *   2. Un super_admin qui désactive le dernier admin actif d'une entreprise
 *
 * AVANT fix : les deux requêtes réussissent (200) → lock-out de l'entreprise
 * APRÈS fix  : 409 dans les deux cas ; désactiver un non-admin reste possible
 */

const request = require('supertest');
const app = require('../src/index');
const { Entreprise, Utilisateur } = require('../src/models');
const bcrypt = require('bcrypt');
const { generateToken } = require('./helpers/auth');

let entreprise, admin, admin2, employe, superAdmin;
const suffix = String(Date.now()).slice(-6);

beforeAll(async () => {
  const hash = await bcrypt.hash('Password1!', 10);

  entreprise = await Entreprise.create({
    nom: 'SelfDisableTest-' + suffix,
    politique_conges: {},
    parametres: {},
  });

  admin = await Utilisateur.create({
    prenom: 'Admin', nom: 'Solo',
    email: `admin.solo.${suffix}@test.local`,
    role: 'admin_entreprise', password_hash: hash, statut: 'actif',
    entreprise_id: entreprise.id,
  });

  admin2 = await Utilisateur.create({
    prenom: 'Admin', nom: 'Deux',
    email: `admin.deux.${suffix}@test.local`,
    role: 'admin_entreprise', password_hash: hash, statut: 'actif',
    entreprise_id: entreprise.id,
  });

  employe = await Utilisateur.create({
    prenom: 'Emp', nom: 'Normal',
    email: `emp.normal.${suffix}@test.local`,
    role: 'employe', password_hash: hash, statut: 'actif',
    service: 'Dev',
    entreprise_id: entreprise.id,
  });

  // super_admin d'une autre entreprise fictive (null entreprise_id acceptable pour super_admin)
  superAdmin = await Utilisateur.create({
    prenom: 'Super', nom: 'Admin',
    email: `super.admin.${suffix}@test.local`,
    role: 'super_admin', password_hash: hash, statut: 'actif',
    entreprise_id: entreprise.id, // même entreprise pour simplifier
  });
});

// Force le statut depuis la DB (méthode statique — pas d'optimisation sur l'instance locale)
async function resetStatuts() {
  await Utilisateur.update({ statut: 'actif' }, { where: { id: admin.id } });
  await Utilisateur.update({ statut: 'actif' }, { where: { id: admin2.id } });
  await Utilisateur.update({ statut: 'actif' }, { where: { id: employe.id } });
}

beforeEach(resetStatuts);

afterAll(async () => {
  for (const u of [employe, admin2, admin, superAdmin]) {
    if (u) await Utilisateur.destroy({ where: { id: u.id } }).catch(() => {});
  }
  if (entreprise) await Entreprise.destroy({ where: { id: entreprise.id } }).catch(() => {});
});

describe('updateUser — garde self-disable / last-admin', () => {
  it('un admin ne peut pas se désactiver lui-même', async () => {
    const token = generateToken(admin);
    const res = await request(app)
      .put(`/api/users/${admin.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ statut: 'inactif' });

    // AVANT fix : 200 (bug) — APRÈS fix : 409
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/désactiver|vous-même|self/i);

    // Le compte doit rester actif
    const fresh = await Utilisateur.findByPk(admin.id, { attributes: ['statut'] });
    expect(fresh.statut).toBe('actif');
  });

  it('ne peut pas désactiver le dernier admin actif de l\'entreprise', async () => {
    // Désactiver admin2 directement en DB → admin est le seul admin actif
    await Utilisateur.update({ statut: 'inactif' }, { where: { id: admin2.id } });

    const token = generateToken(superAdmin);
    const res = await request(app)
      .put(`/api/users/${admin.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ statut: 'inactif' });

    // AVANT fix : 200 (bug) — APRÈS fix : 409
    expect(res.status).toBe(409);

    const fresh = await Utilisateur.findByPk(admin.id, { attributes: ['statut'] });
    expect(fresh.statut).toBe('actif');
  });

  it('un admin peut désactiver un employé normalement', async () => {
    const token = generateToken(admin);
    const res = await request(app)
      .put(`/api/users/${employe.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ statut: 'inactif' });

    expect(res.status).toBe(200);

    const fresh = await Utilisateur.findByPk(employe.id, { attributes: ['statut'] });
    expect(fresh.statut).toBe('inactif');
  });

  it('avec deux admins actifs, désactiver l\'un d\'eux est possible', async () => {
    // admin et admin2 sont tous deux actifs (resetStatuts dans beforeEach)
    const token = generateToken(admin);
    const res = await request(app)
      .put(`/api/users/${admin2.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ statut: 'inactif' });

    // admin reste actif → admin2 peut être désactivé
    expect(res.status).toBe(200);

    const fresh = await Utilisateur.findByPk(admin2.id, { attributes: ['statut'] });
    expect(fresh.statut).toBe('inactif');
  });
});
