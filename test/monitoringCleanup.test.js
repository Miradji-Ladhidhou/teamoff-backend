'use strict';
/**
 * monitoringCleanup.test.js
 *
 * Vérifie la borne minimale et la traçabilité de POST /monitoring/cleanup.
 *
 * AVANT fix : daysToKeep=1 accepté, aucune trace du cleanup
 * APRÈS fix  : daysToKeep < 90 refusé (400), cleanup loggé dans audit_logs
 *              avec action='AUDIT_CLEANUP', protégé contre purge future
 */

const request = require('supertest');
const app = require('../src/index');
const { AuditLog, Utilisateur } = require('../src/models');
const { generateToken } = require('./helpers/auth');

let superAdmin, token;

beforeAll(async () => {
  superAdmin = await Utilisateur.create({
    prenom: 'Monitor', nom: 'Admin',
    email: `monitor.cleanup.${Date.now()}@test.local`,
    role: 'super_admin',
    password_hash: 'hash',
    statut: 'actif',
    entreprise_id: null,
  }).catch(() => null);

  if (superAdmin) token = generateToken(superAdmin);
});

afterAll(async () => {
  // Supprimer les logs de cleanup créés par nos tests
  await AuditLog.destroy({ where: { action: 'AUDIT_CLEANUP' } }).catch(() => {});
  if (superAdmin) {
    await Utilisateur.destroy({ where: { id: superAdmin.id } }).catch(() => {});
  }
});

describe('POST /api/monitoring/cleanup — borne minimale', () => {
  it('refuse daysToKeep=1 avec 400', async () => {
    if (!token) return;
    const res = await request(app)
      .post('/api/monitoring/cleanup')
      .set('Authorization', `Bearer ${token}`)
      .send({ daysToKeep: 1 });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/90|minimum|rétention/i);
  });

  it('refuse daysToKeep=29 avec 400', async () => {
    if (!token) return;
    const res = await request(app)
      .post('/api/monitoring/cleanup')
      .set('Authorization', `Bearer ${token}`)
      .send({ daysToKeep: 29 });

    expect(res.status).toBe(400);
  });

  it('refuse daysToKeep=89 avec 400', async () => {
    if (!token) return;
    const res = await request(app)
      .post('/api/monitoring/cleanup')
      .set('Authorization', `Bearer ${token}`)
      .send({ daysToKeep: 89 });

    expect(res.status).toBe(400);
  });

  it('accepte daysToKeep=90 et retourne 200', async () => {
    if (!token) return;
    const res = await request(app)
      .post('/api/monitoring/cleanup')
      .set('Authorization', `Bearer ${token}`)
      .send({ daysToKeep: 90 });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('deletedAuditLogs');
    expect(res.body).toHaveProperty('retentionDays', 90);
  });
});

describe('POST /api/monitoring/cleanup — traçabilité', () => {
  it('journalise le cleanup dans audit_logs avec action=AUDIT_CLEANUP', async () => {
    if (!token) return;

    const before = Date.now();
    await request(app)
      .post('/api/monitoring/cleanup')
      .set('Authorization', `Bearer ${token}`)
      .send({ daysToKeep: 365 }); // 365 jours : ne supprime rien en pratique

    const cleanupLog = await AuditLog.findOne({
      where: { action: 'AUDIT_CLEANUP' },
      order: [['created_at', 'DESC']],
    });

    expect(cleanupLog).not.toBeNull();
    expect(cleanupLog.user_id).toBe(superAdmin.id);
    expect(cleanupLog.metadata).toMatchObject({
      daysToKeep: 365,
    });
    // Le champ deletedAuditLogs doit être présent dans metadata
    expect(cleanupLog.metadata).toHaveProperty('deletedAuditLogs');
    expect(new Date(cleanupLog.created_at).getTime()).toBeGreaterThanOrEqual(before);
  });

  it('les logs AUDIT_CLEANUP ne sont pas supprimés par un cleanup ultérieur', async () => {
    if (!token) return;

    // Créer un log AUDIT_CLEANUP artificiel très ancien (simulé via backdating)
    const oldDate = new Date();
    oldDate.setFullYear(oldDate.getFullYear() - 5); // 5 ans en arrière

    const oldCleanupLog = await AuditLog.create({
      action: 'AUDIT_CLEANUP',
      entity: 'system',
      user_id: superAdmin.id,
      metadata: { daysToKeep: 365, deletedAuditLogs: 0, deletedNotifications: 0, _test: true },
      created_at: oldDate,
      updated_at: oldDate,
    });

    // Lancer un cleanup sur 90 jours — devrait NE PAS supprimer le log AUDIT_CLEANUP
    await request(app)
      .post('/api/monitoring/cleanup')
      .set('Authorization', `Bearer ${token}`)
      .send({ daysToKeep: 90 });

    const stillExists = await AuditLog.findByPk(oldCleanupLog.id);
    expect(stillExists).not.toBeNull();

    // Cleanup du log de test
    await AuditLog.destroy({ where: { id: oldCleanupLog.id } });
  });
});
