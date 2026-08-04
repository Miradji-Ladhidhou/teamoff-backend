'use strict';
/**
 * accountLockoutAudit.test.js — Fix #24
 *
 * Vérifie qu'un verrouillage de compte déclenche bien un log ACCOUNT_LOCKED en DB.
 */

const request = require('supertest');
const bcrypt  = require('bcrypt');
const app     = require('../src/index');
const { Utilisateur, Entreprise, AuditLog, sequelize } = require('../src/models');

const BAD_PASSWORD  = 'wrong_password!';
const GOOD_PASSWORD = 'TestLock1234!';

let entreprise;
let victim;

beforeAll(async () => {
  entreprise = await Entreprise.create({
    nom: 'Lockout Test Corp',
    politique_conges: {},
    parametres: {},
    statut: 'active',
  });

  victim = await Utilisateur.create({
    entreprise_id: entreprise.id,
    prenom: 'Victim',
    nom:    'User',
    email:  `victim.lockout.${Date.now()}@test.internal`,
    role:   'employe',
    password_hash: await bcrypt.hash(GOOD_PASSWORD, 10),
    statut: 'actif',
    // Pré-charger 4 tentatives échouées (seuil par défaut = 5)
    failed_login_attempts: 4,
  });
});

afterAll(async () => {
  await AuditLog.destroy({ where: { entreprise_id: entreprise.id } });
  await Utilisateur.destroy({ where: { id: victim.id } });
  await Entreprise.destroy({ where: { id: entreprise.id } });
});

describe('Fix #24 — Verrouillage de compte audité', () => {
  it('La 5ème tentative échouée verrouille le compte et crée un log ACCOUNT_LOCKED', async () => {
    const before = await AuditLog.count({
      where: { action: 'ACCOUNT_LOCKED', entity_id: victim.id },
    });

    // Déclenche le verrouillage (tentative #5)
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: victim.email, password: BAD_PASSWORD });

    expect(res.status).toBe(401);

    // Le compte doit être verrouillé en DB
    const updated = await Utilisateur.findByPk(victim.id);
    expect(updated.locked_until).not.toBeNull();
    expect(new Date(updated.locked_until).getTime()).toBeGreaterThan(Date.now());

    // Un log ACCOUNT_LOCKED doit exister
    const after = await AuditLog.count({
      where: { action: 'ACCOUNT_LOCKED', entity_id: victim.id },
    });
    expect(after).toBe(before + 1);
  });

  it('Le log ACCOUNT_LOCKED contient les bons métadatas', async () => {
    const log = await AuditLog.findOne({
      where: { action: 'ACCOUNT_LOCKED', entity_id: victim.id },
      order: [['created_at', 'DESC']],
    });

    expect(log).not.toBeNull();
    expect(log.entity).toBe('utilisateur');
    expect(log.entreprise_id).toBe(entreprise.id);
    expect(log.user_id).toBeNull(); // action système, pas un user connecté
    expect(log.metadata).toMatchObject({
      email:           victim.email,
      failed_attempts: 5,
    });
    expect(log.metadata.locked_until).toBeDefined();
  });

  it('Une tentative avant le seuil ne génère pas de log ACCOUNT_LOCKED', async () => {
    // Créer un utilisateur avec 0 tentatives
    const fresh = await Utilisateur.create({
      entreprise_id: entreprise.id,
      prenom: 'Fresh',
      nom:    'User',
      email:  `fresh.lockout.${Date.now()}@test.internal`,
      role:   'employe',
      password_hash: await bcrypt.hash(GOOD_PASSWORD, 10),
      statut: 'actif',
      failed_login_attempts: 0,
    });

    try {
      // Une seule tentative échouée (tentative #1 sur 5)
      await request(app)
        .post('/api/auth/login')
        .send({ email: fresh.email, password: BAD_PASSWORD });

      const count = await AuditLog.count({
        where: { action: 'ACCOUNT_LOCKED', entity_id: fresh.id },
      });
      expect(count).toBe(0);
    } finally {
      await AuditLog.destroy({ where: { entity_id: fresh.id } });
      await Utilisateur.destroy({ where: { id: fresh.id } });
    }
  });
});
