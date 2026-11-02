'use strict';

const sanitizeLogData = require('../../src/utils/sanitizeLogData');
const { loadSource } = require('./loadSource');

test.each([
  ['password="synthetic secret with spaces"', 'password=***'],
  ['{"client_secret":"synthetic secret"}', '{"client_secret":***}'],
  ['Authorization: Bearer synthetic-token', 'Authorization: *** ***'],
  ['Authorization: Basic synthetic-credentials', 'Authorization: *** ***'],
  ['Cookie: session=synthetic-token; secret=synthetic-secret', 'Cookie: ***'],
  ['postgres://actor:synthetic-secret@localhost:5432/copy', 'postgres://***/copy'],
])('sensitive string %s is redacted', (value, expected) => {
  expect(sanitizeLogData.sanitizeMessage(value)).toBe(expected);
});

test('environment secrets and encoded values are masked without displaying actual environment values', () => {
  const sanitizer = loadSource('src/utils/sanitizeLogData.js', {}, {
    process: { env: { MAIL_PASS: 'synthetic secret', DATABASE_URL: 'postgres://actor:other%20secret@localhost/copy' } },
  }).exports;
  expect(sanitizer.sanitizeMessage('failure synthetic secret synthetic%20secret other secret other%20secret'))
    .toBe('failure *** *** *** ***');
});

test('nested data and error causes preserve structure but not credentials', () => {
  const error = Object.assign(new Error('password=synthetic-secret'), {
    cause: new Error('token=synthetic-token'), cleanupError: new Error('client_secret=synthetic-secret'),
  });
  expect(sanitizeLogData.sanitizeError(error)).toBe(error);
  expect(error.cause.message).toBe('token=***');
  expect(error.cleanupError.message).toBe('client_secret=***');
  expect(sanitizeLogData({ password: 'synthetic', nested: { message: 'token=synthetic-token' } }))
    .toEqual({ password: '***', nested: { message: 'token=***' } });
});

test('private key blocks are redacted', () => {
  expect(sanitizeLogData.sanitizeMessage('failed -----BEGIN PRIVATE KEY-----\nsynthetic\n-----END PRIVATE KEY-----'))
    .toBe('failed ***');
});

test('a partially sent HTTP response is not replaced with a second JSON response', () => {
  const logger = { error: jest.fn() };
  const handler = loadSource('src/middlewares/errorHandler.js', {
    '../utils/logger': logger, '../utils/sanitizeLogData': sanitizeLogData,
  }).exports;
  const error = new Error('stream failed token=synthetic-token');
  const res = { headersSent: true, status: jest.fn(), json: jest.fn() };
  const next = jest.fn();
  handler(error, {}, res, next);
  expect(next).toHaveBeenCalledWith(error);
  expect(res.status).not.toHaveBeenCalled();
  expect(logger.error).toHaveBeenCalledWith('unhandled_error', expect.objectContaining({ errMsg: 'stream failed token=***' }));
});

test('cron errors are sanitized and never reach a real scheduler or database', async () => {
  const logger = { error: jest.fn(), info: jest.fn() };
  const runDatabaseBackup = jest.fn().mockRejectedValue(new Error('dump failed password=synthetic-secret'));
  const cleanupOldBackups = jest.fn();
  const service = loadSource('src/cron/backupCron.js', {
    '../services/cronTaskGroup': require('../../src/services/cronTaskGroup'),
    'node-cron': { schedule: jest.fn() }, '../utils/logger': logger,
    '../utils/sanitizeLogData': sanitizeLogData,
    '../services/systemSettingsService': { getSettings: async () => ({ dbRetentionDays: 7 }) },
    '../services/backupService': { runDatabaseBackup, cleanupOldBackups },
  }).exports;
  await service.runBackupJob();
  expect(logger.error).toHaveBeenCalledWith('[BackupCron] Erreur lors de la sauvegarde automatique :', 'dump failed password=***');
  expect(cleanupOldBackups).not.toHaveBeenCalled();
});
