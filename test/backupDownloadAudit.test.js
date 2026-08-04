'use strict';
/**
 * backupDownloadAudit.test.js — Fix #34
 *
 * Chaque téléchargement de backup doit créer un AuditLog SYSTEM_BACKUP_DOWNLOADED
 * avec le nom du fichier, l'id de l'utilisateur et l'entreprise.
 * AVANT fix : GET /api/settings/backups/:filename n'écrivait aucune trace.
 * APRÈS fix  : un AuditLog est créé avant l'envoi du fichier.
 */

const fs      = require('fs');
const path    = require('path');
const request = require('supertest');
const bcrypt  = require('bcrypt');
const app     = require('../src/index');
const { Entreprise, Utilisateur, AuditLog } = require('../src/models');
const { generateToken } = require('./helpers/auth');
const { backupsDir }   = require('../src/services/backupService');

const FAKE_FILENAME = `teamoff_backup_test34_${Date.now()}.sql`;
const FAKE_FILEPATH = path.join(backupsDir, FAKE_FILENAME);

let entreprise, superAdmin, token;

beforeAll(async () => {
  const hash = await bcrypt.hash('Test1234!', 10);

  entreprise = await Entreprise.create({
    nom: `BackupAudit34_${Date.now()}`,
    politique_conges: {}, parametres: {}, statut: 'active',
  });

  superAdmin = await Utilisateur.create({
    entreprise_id: entreprise.id,
    prenom: 'Super', nom: 'Backup34',
    email: `super.bk34.${Date.now()}@test.internal`,
    role: 'super_admin', password_hash: hash, statut: 'actif',
  });

  token = generateToken(superAdmin);

  // Créer un fichier .sql factice dans le répertoire backups
  fs.mkdirSync(backupsDir, { recursive: true });
  fs.writeFileSync(FAKE_FILEPATH, '-- fake backup for test\n');
});

afterAll(async () => {
  // Supprimer le fichier factice
  fs.rmSync(FAKE_FILEPATH, { force: true });

  await AuditLog.destroy({ where: { user_id: superAdmin.id } }).catch(() => {});
  await Utilisateur.destroy({ where: { id: superAdmin.id } }).catch(() => {});
  await Entreprise.destroy({ where: { id: entreprise.id } }).catch(() => {});
});

describe('Fix #34 — Audit log téléchargement backup', () => {
  it('GET /backups/:filename crée un AuditLog SYSTEM_BACKUP_DOWNLOADED', async () => {
    const before = new Date();

    const res = await request(app)
      .get(`/api/settings/backups/${FAKE_FILENAME}`)
      .set('Authorization', `Bearer ${token}`);

    // La réponse doit être le fichier (200) ou une redirection — pas une erreur
    expect(res.status).toBe(200);

    // L'audit doit être écrit AVANT le download (await dans le handler)
    const log = await AuditLog.findOne({
      where: {
        action: 'SYSTEM_BACKUP_DOWNLOADED',
        user_id: superAdmin.id,
      },
      order: [['created_at', 'DESC']],
    });

    expect(log).not.toBeNull();
    expect(log.metadata?.filename).toBe(FAKE_FILENAME);
    expect(new Date(log.created_at).getTime()).toBeGreaterThanOrEqual(before.getTime());
  });

  it('téléchargement d\'un fichier inexistant → 404, aucun AuditLog créé', async () => {
    const countBefore = await AuditLog.count({
      where: { action: 'SYSTEM_BACKUP_DOWNLOADED', user_id: superAdmin.id },
    });

    const res = await request(app)
      .get(`/api/settings/backups/inexistant_${Date.now()}.sql`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(404);

    const countAfter = await AuditLog.count({
      where: { action: 'SYSTEM_BACKUP_DOWNLOADED', user_id: superAdmin.id },
    });
    expect(countAfter).toBe(countBefore); // pas de log pour un fichier inexistant
  });

  it('nom de fichier invalide (path traversal) → 400, aucun AuditLog créé', async () => {
    const countBefore = await AuditLog.count({
      where: { action: 'SYSTEM_BACKUP_DOWNLOADED', user_id: superAdmin.id },
    });

    const res = await request(app)
      .get('/api/settings/backups/..%2F..%2Fetc%2Fpasswd')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(400);

    const countAfter = await AuditLog.count({
      where: { action: 'SYSTEM_BACKUP_DOWNLOADED', user_id: superAdmin.id },
    });
    expect(countAfter).toBe(countBefore);
  });

  it('sans authentification → 401, aucun AuditLog', async () => {
    const countBefore = await AuditLog.count({
      where: { action: 'SYSTEM_BACKUP_DOWNLOADED' },
    });

    const res = await request(app)
      .get(`/api/settings/backups/${FAKE_FILENAME}`);

    expect(res.status).toBe(401);

    const countAfter = await AuditLog.count({
      where: { action: 'SYSTEM_BACKUP_DOWNLOADED' },
    });
    expect(countAfter).toBe(countBefore);
  });
});
