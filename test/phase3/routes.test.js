'use strict';

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { loadSource } = require('./loadSource');

const key = 'phase3-simulation-key-never-used-by-application';
const logger = { error: jest.fn(), warn: jest.fn() };
const audit = { create: jest.fn().mockResolvedValue({}) };
const user = { findByPk: jest.fn() };
const company = { findByPk: jest.fn().mockResolvedValue({ statut: 'active' }) };
const auth = loadSource('src/middlewares/authJwt.js', {
  jsonwebtoken: jwt, dotenv: { config: jest.fn() },
  '../models': { Utilisateur: user, Entreprise: company }, '../utils/logger': logger,
}, { process: { env: { JWT_SECRET: key } } }).exports;
const authorizeRole = loadSource('src/middlewares/authorizeRole.js', { '../utils/logger': logger }).exports;
const errorHandler = loadSource('src/middlewares/errorHandler.js', {
  '../utils/logger': logger, '../utils/sanitizeLogData': require('../../src/utils/sanitizeLogData'),
}).exports;
const backup = {
  ...require('../../src/services/backupService'),
  runDatabaseBackup: jest.fn().mockResolvedValue({
    filename: 'simulated.sql', filePath: '/virtual/simulated.sql', sizeBytes: 1, createdAt: '2026-11-01',
  }),
};
const settings = { updateSettings: jest.fn().mockResolvedValue({}) };
const drive = { uploadBackupToDrive: jest.fn(), listDriveBackups: jest.fn(), downloadFromDrive: jest.fn() };
const downloadFs = {
  createReadStream: jest.fn((file, options) =>
    require('stream').Readable.from([Buffer.from('simulated dump').subarray(options.start || 0, options.end === undefined ? undefined : options.end + 1)])),
  closeSync: jest.fn(),
};
backup.openPublishedBackup = jest.fn().mockReturnValue({ fd: 42, sizeBytes: 14 });
const router = loadSource('src/routes/settings.js', {
  express, os: {}, fs: downloadFs, path: require('path'), json2csv: { Parser: jest.fn() },
  'stream/promises': require('stream/promises'),
  sequelize: require('sequelize'), '../middlewares/authorizeRole': authorizeRole,
  '../config/database': { query: jest.fn() },
  '../services/systemSettingsService': settings,
  '../services/emailService': {}, '../services/backupService': backup,
  '../services/googleDriveService': drive,
  '../services/auditActions': require('../../src/services/auditActions'),
  '../models': { AuditLog: audit, Utilisateur: user },
  '../cron/backupCron': { initBackupCron: jest.fn() },
}).exports;
const app = express();
app.use(express.json());
app.use('/api/settings', auth, router);
app.use(errorHandler);

beforeEach(() => {
  user.findByPk.mockResolvedValue({ id: 'actor', role: 'super_admin', statut: 'actif' });
});

test.each(['admin_entreprise', 'manager', 'employe', 'apprenti'])('%s cannot execute restore', async role => {
  user.findByPk.mockResolvedValue({ id: 'actor', role, statut: 'actif', entreprise_id: 'company' });
  const res = await request(app).post('/api/settings/actions/restore-drive')
    .set('Authorization', `Bearer ${jwt.sign({ id: 'actor' }, key)}`).send({ fileId: 'fake' });
  expect(res.status).toBe(403);
  expect(drive.downloadFromDrive).not.toHaveBeenCalled();
  expect(audit.create).not.toHaveBeenCalled();
});

test.each([undefined, 'Bearer invalid'])('missing or invalid authentication refuses restore: %s', async token => {
  const req = request(app).post('/api/settings/actions/restore-drive');
  if (token) req.set('Authorization', token);
  const res = await req.send({ fileId: 'fake' });
  expect(res.status).toBe(401);
  expect(drive.downloadFromDrive).not.toHaveBeenCalled();
});

test('inactive superadmin is still refused', async () => {
  user.findByPk.mockResolvedValue({ id: 'actor', role: 'super_admin', statut: 'inactif' });
  const res = await request(app).post('/api/settings/actions/restore-drive')
    .set('Authorization', `Bearer ${jwt.sign({ id: 'actor' }, key)}`).send({ fileId: 'fake' });
  expect(res.status).toBe(403);
});

test('authorized superadmin receives explicit 503, no Drive request or successful audit', async () => {
  const res = await request(app).post('/api/settings/actions/restore-drive')
    .set('Authorization', `Bearer ${jwt.sign({ id: 'actor' }, key)}`)
    .send({ fileId: 'fake', filename: '../../source.sql' });
  expect(res.status).toBe(503);
  expect(res.body.message).toContain('Aucune restauration exécutée');
  expect(drive.downloadFromDrive).not.toHaveBeenCalled();
  expect(audit.create).not.toHaveBeenCalled();
  expect(logger.error).toHaveBeenCalledWith('unhandled_error', expect.objectContaining({
    errMsg: expect.stringContaining('Restauration indisponible'),
    userId: 'actor', role: 'super_admin',
  }));
});

test('missing fileId retains existing 400 validation', async () => {
  const res = await request(app).post('/api/settings/actions/restore-drive')
    .set('Authorization', `Bearer ${jwt.sign({ id: 'actor' }, key)}`).send({});
  expect(res.status).toBe(400);
  expect(drive.downloadFromDrive).not.toHaveBeenCalled();
});

test('manual backup route preserves success audit with simulated dump only', async () => {
  const res = await request(app).post('/api/settings/actions/backup')
    .set('Authorization', `Bearer ${jwt.sign({ id: 'actor' }, key)}`).send({});
  expect(res.status).toBe(200);
  expect(backup.runDatabaseBackup).toHaveBeenCalledTimes(1);
  expect(audit.create).toHaveBeenCalledWith(expect.objectContaining({
    action: 'SYSTEM_BACKUP_CREATED', user_id: 'actor',
    metadata: { filename: 'simulated.sql', sizeBytes: 1 },
  }));
});

test('backup error reaches HTTP error handler without a successful audit', async () => {
  backup.runDatabaseBackup.mockRejectedValueOnce(Object.assign(new Error('simulated dump error'), { statusCode: 500 }));
  const res = await request(app).post('/api/settings/actions/backup')
    .set('Authorization', `Bearer ${jwt.sign({ id: 'actor' }, key)}`).send({});
  expect(res.status).toBe(500);
  expect(audit.create).not.toHaveBeenCalled();
});

function authorized(req) {
  return req.set('Authorization', `Bearer ${jwt.sign({ id: 'actor' }, key)}`);
}

test('published download keeps audit, attachment and streams the validated descriptor', async () => {
  const res = await authorized(request(app).get('/api/settings/backups/simulated.sql'));
  expect(res.status).toBe(200);
  expect(res.headers['content-disposition']).toContain('attachment; filename="simulated.sql"');
  expect(res.headers['content-length']).toBe('14');
  expect(downloadFs.createReadStream).toHaveBeenCalledWith(null, { fd: 42, autoClose: true });
  expect(audit.create).toHaveBeenCalledWith(expect.objectContaining({
    action: 'SYSTEM_BACKUP_DOWNLOADED', metadata: { filename: 'simulated.sql' },
  }));
  expect(audit.create.mock.invocationCallOrder[0]).toBeLessThan(downloadFs.createReadStream.mock.invocationCallOrder[0]);
});

test.each([400, 404])('download validation failure %s cannot audit or send a file', async statusCode => {
  backup.openPublishedBackup.mockImplementationOnce(() => {
    throw Object.assign(new Error('invalid backup'), { statusCode });
  });
  const res = await authorized(request(app).get('/api/settings/backups/invalid.sql'));
  expect(res.status).toBe(statusCode);
  expect(audit.create).not.toHaveBeenCalled();
  expect(downloadFs.createReadStream).not.toHaveBeenCalled();
});

test('audit failure closes the descriptor and prevents download', async () => {
  audit.create.mockRejectedValueOnce(new Error('audit failed'));
  const res = await authorized(request(app).get('/api/settings/backups/simulated.sql'));
  expect(res.status).toBe(500);
  expect(downloadFs.closeSync).toHaveBeenCalledWith(42);
  expect(downloadFs.createReadStream).not.toHaveBeenCalled();
});

test('descriptor cleanup failure never replaces audit failure', async () => {
  audit.create.mockRejectedValueOnce(new Error('audit failed'));
  downloadFs.closeSync.mockImplementationOnce(() => { throw new Error('close failed'); });
  const res = await authorized(request(app).get('/api/settings/backups/simulated.sql'));
  expect(res.status).toBe(500);
  expect(res.body.message).toBe('audit failed');
  expect(logger.error).toHaveBeenCalledWith('unhandled_error', expect.objectContaining({
    cleanupError: 'close failed',
  }));
});

test('Drive upload failure returns an error without a success audit', async () => {
  drive.uploadBackupToDrive.mockRejectedValueOnce(new Error('upload failed token=synthetic-token'));
  const res = await authorized(request(app).post('/api/settings/actions/backup-drive')).send({});
  expect(res.status).toBe(500);
  expect(res.body.message).toBe('upload failed token=***');
  expect(audit.create).not.toHaveBeenCalled();
  expect(JSON.stringify(logger.error.mock.calls)).not.toContain('synthetic-token');
});

test('Drive upload success retains existing response and audit', async () => {
  drive.uploadBackupToDrive.mockResolvedValueOnce({ id: 'drive-id', name: 'simulated.sql' });
  const res = await authorized(request(app).post('/api/settings/actions/backup-drive')).send({});
  expect(res.status).toBe(200);
  expect(res.body.drive.fileId).toBe('drive-id');
  expect(audit.create).toHaveBeenCalledWith(expect.objectContaining({
    action: 'SYSTEM_BACKUP_CREATED',
    metadata: expect.objectContaining({ destination: 'google_drive', driveFileId: 'drive-id' }),
  }));
});

test('HTTP and logs mask sensitive error text while retaining technical cause and code', async () => {
  backup.runDatabaseBackup.mockRejectedValueOnce(Object.assign(new Error(
    'ECONNRESET postgres://actor:synthetic-secret@localhost/copy access_token=synthetic-token'
  ), { statusCode: 500 }));
  const res = await authorized(request(app).post('/api/settings/actions/backup')).send({});
  expect(res.status).toBe(500);
  expect(res.body.message).toContain('ECONNRESET');
  for (const text of [res.body.message, JSON.stringify(logger.error.mock.calls)]) {
    expect(text).not.toContain('synthetic-secret');
    expect(text).not.toContain('synthetic-token');
  }
});

test('backup response does not disclose settings secrets', async () => {
  settings.updateSettings.mockResolvedValueOnce({ smtpPassword: 'synthetic-secret', slackWebhook: 'synthetic-webhook' });
  const res = await authorized(request(app).post('/api/settings/actions/backup')).send({});
  expect(res.status).toBe(200);
  expect(res.body.settings).toEqual({ smtpPasswordSet: true, slackWebhookSet: true });
});

test('a valid byte range preserves partial download behavior on the validated descriptor', async () => {
  const res = await authorized(request(app).get('/api/settings/backups/simulated.sql')).set('Range', 'bytes=0-3');
  expect(res.status).toBe(206);
  expect(res.headers['content-range']).toBe('bytes 0-3/14');
  expect(res.headers['content-length']).toBe('4');
  expect(downloadFs.createReadStream).toHaveBeenCalledWith(null, { fd: 42, autoClose: true, start: 0, end: 3 });
});

test('an unsatisfiable range closes its descriptor without streaming', async () => {
  const res = await authorized(request(app).get('/api/settings/backups/simulated.sql')).set('Range', 'bytes=99-100');
  expect(res.status).toBe(416);
  expect(res.headers['content-range']).toBe('bytes */14');
  expect(downloadFs.closeSync).toHaveBeenCalledWith(42);
  expect(downloadFs.createReadStream).not.toHaveBeenCalled();
});
