'use strict';
/**
 * settingsAuditEntrepriseId.test.js — Fix #36
 *
 * Les actions super_admin sur /api/settings sont globales à la plateforme.
 * Elles doivent être journalisées avec entreprise_id = null.
 * AVANT fix : resolveEntrepriseId retourne req.user.entreprise_id (entreprise du
 *             super_admin lui-même), valeur arbitraire et trompeuse.
 * APRÈS fix  : entreprise_id = null dans l'AuditLog.
 */

const request = require('supertest');
const bcrypt  = require('bcrypt');
const app     = require('../src/index');
const { Entreprise, Utilisateur, AuditLog } = require('../src/models');
const { generateToken } = require('./helpers/auth');

const TS = Date.now();

let platformEntreprise, superAdmin, token;

beforeAll(async () => {
  const hash = await bcrypt.hash('Test1234!', 10);

  platformEntreprise = await Entreprise.create({
    nom: `Platform36_${TS}`,
    politique_conges: {}, parametres: {}, statut: 'active',
  });

  superAdmin = await Utilisateur.create({
    entreprise_id: platformEntreprise.id,
    prenom: 'Super', nom: 'Audit36',
    email: `super.audit36.${TS}@test.internal`,
    role: 'super_admin', password_hash: hash, statut: 'actif',
  });

  token = generateToken(superAdmin);
});

afterAll(async () => {
  await AuditLog.destroy({ where: { user_id: superAdmin.id } }).catch(() => {});
  await Utilisateur.destroy({ where: { id: superAdmin.id } }).catch(() => {});
  await Entreprise.destroy({ where: { id: platformEntreprise.id } }).catch(() => {});
});

describe('Fix #36 — AuditLog settings : entreprise_id doit être null pour super_admin', () => {

  it('POST /actions/maintenance → AuditLog.entreprise_id est null (scope global)', async () => {
    const res = await request(app)
      .post('/api/settings/actions/maintenance')
      .set('Authorization', `Bearer ${token}`)
      .send({ enabled: true });

    // L'action doit réussir
    expect(res.status).toBe(200);

    // L'AuditLog doit être créé avec entreprise_id = null
    const log = await AuditLog.findOne({
      where: {
        action: 'SYSTEM_MAINTENANCE_TOGGLED',
        user_id: superAdmin.id,
      },
      order: [['created_at', 'DESC']],
    });

    expect(log).not.toBeNull();

    // AVANT fix : entreprise_id === platformEntreprise.id (valeur arbitraire)
    // APRÈS fix  : entreprise_id === null (scope global)
    expect(log.entreprise_id).toBeNull();

    // Remettre maintenance à false (cleanup)
    await request(app)
      .post('/api/settings/actions/maintenance')
      .set('Authorization', `Bearer ${token}`)
      .send({ enabled: false });
  });

  it('PUT /settings → AuditLog.entreprise_id est null pour une mise à jour de paramètres', async () => {
    const res = await request(app)
      .put('/api/settings')
      .set('Authorization', `Bearer ${token}`)
      .send({ maxLeavePerYear: 30 });

    expect(res.status).toBe(200);

    const log = await AuditLog.findOne({
      where: {
        action: 'SYSTEM_SETTINGS_UPDATED',
        user_id: superAdmin.id,
      },
      order: [['created_at', 'DESC']],
    });

    expect(log).not.toBeNull();
    expect(log.entreprise_id).toBeNull();
  });

  it('entreprise_id de la platformEntreprise du super_admin ne doit PAS figurer dans les logs settings', async () => {
    const logsWithWrongId = await AuditLog.findAll({
      where: {
        user_id: superAdmin.id,
        entreprise_id: platformEntreprise.id,
        entity: 'system_settings',
      },
    });

    // Aucun log settings ne doit pointer vers l'entreprise du super_admin
    expect(logsWithWrongId.length).toBe(0);
  });
});
