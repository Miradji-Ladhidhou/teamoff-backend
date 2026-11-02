'use strict';

const path = require('path');
const { loadSource } = require('./loadSource');

function download() {
  const fs = {
    mkdtempSync: jest.fn().mockReturnValue('/virtual/teamoff-restore-random'),
    createWriteStream: jest.fn().mockReturnValue({ stream: true }),
    rmSync: jest.fn(),
    chmodSync: jest.fn(),
    createReadStream: jest.fn().mockReturnValue({ destroy: jest.fn() }),
  };
  const get = jest.fn().mockResolvedValue({ data: { response: true, destroy: jest.fn() } });
  const create = jest.fn().mockResolvedValue({ data: { id: 'mock-file' } });
  const pipeline = jest.fn().mockResolvedValue();
  const logger = { error: jest.fn() };
  const service = loadSource('src/services/googleDriveService.js', {
    googleapis: { google: {
      auth: { OAuth2: function OAuth2() { this.setCredentials = jest.fn(); } },
      drive: () => ({ files: { get, create } }),
    } },
    fs, path, os: { tmpdir: () => '/virtual' }, 'stream/promises': { pipeline },
    '../models': { SystemSetting: { findOne: jest.fn().mockResolvedValue(null) } },
    '../utils/totpCrypto': { decryptTotpSecret: jest.fn() },
    '../utils/logger': logger,
    '../utils/sanitizeLogData': require('../../src/utils/sanitizeLogData'),
  }, { process: { env: {
    GOOGLE_OAUTH_CLIENT_ID: 'fake', GOOGLE_OAUTH_CLIENT_SECRET: 'fake',
    GOOGLE_OAUTH_REFRESH_TOKEN: 'fake',
    GOOGLE_DRIVE_FOLDER_ID: 'fake-folder',
  } } }).exports;
  return { service, fs, get, create, pipeline, logger };
}

test.each(['../../source.sql', '/absolute/source.sql', 'normal.sql'])('untrusted filename %s cannot choose the destination', async filename => {
  const d = download();
  const result = await d.service.downloadFromDrive('file', filename);
  expect(result).toBe('/virtual/teamoff-restore-random/backup.sql');
  expect(d.fs.mkdtempSync).toHaveBeenCalledWith('/virtual/teamoff-restore-');
  expect(d.fs.createWriteStream).toHaveBeenCalledWith(result, { flags: 'wx', mode: 0o600 });
  expect(d.pipeline).toHaveBeenCalledTimes(1);
  expect(d.fs.rmSync).not.toHaveBeenCalled();
});

test.each(['download', 'stream'])('%s failure is propagated and only private temporary directory is cleaned', async stage => {
  const d = download();
  const error = new Error(`${stage} failed`);
  (stage === 'download' ? d.get : d.pipeline).mockRejectedValue(error);
  await expect(d.service.downloadFromDrive('file')).rejects.toBe(error);
  expect(d.fs.rmSync).toHaveBeenCalledWith('/virtual/teamoff-restore-random', { recursive: true, force: true });
});

test('temporary directory allocation failure happens before network request', async () => {
  const d = download();
  d.fs.mkdtempSync.mockImplementation(() => { throw new Error('temporary storage unavailable'); });
  await expect(d.service.downloadFromDrive('file')).rejects.toThrow('temporary storage unavailable');
  expect(d.get).not.toHaveBeenCalled();
});

test('cleanup failure cannot replace the initial download error and is logged separately', async () => {
  const d = download();
  const error = new Error('download failed');
  const cleanupError = new Error('cleanup failed');
  d.get.mockRejectedValue(error);
  d.fs.rmSync.mockImplementation(() => { throw cleanupError; });
  await expect(d.service.downloadFromDrive('file')).rejects.toBe(error);
  expect(error.cleanupError).toBe(cleanupError);
  expect(d.logger.error).toHaveBeenCalledWith('drive_temporary_cleanup_failed', { error: 'cleanup failed' });
});

test('successful download is private and the successful caller cleans it explicitly', async () => {
  const d = download();
  const file = await d.service.downloadFromDrive('file');
  expect(d.fs.chmodSync).toHaveBeenCalledWith('/virtual/teamoff-restore-random', 0o700);
  expect(d.fs.chmodSync).toHaveBeenCalledWith(file, 0o600);
  d.service.cleanupDownloadedBackup(file);
  expect(d.fs.rmSync).toHaveBeenCalledWith('/virtual/teamoff-restore-random', { recursive: true, force: true });
  expect(() => d.service.cleanupDownloadedBackup('/unrelated')).toThrow(/inconnu/);
});

test('scoped successful consumption always cleans downloaded data', async () => {
  const d = download();
  const consume = jest.fn().mockResolvedValue('consumed');
  await expect(d.service.withDownloadedBackup('file', consume)).resolves.toBe('consumed');
  expect(consume).toHaveBeenCalledWith('/virtual/teamoff-restore-random/backup.sql');
  expect(d.fs.rmSync).toHaveBeenCalledTimes(1);
});

test('scoped cleanup error fails the operation without claiming successful consumption', async () => {
  const d = download();
  d.fs.rmSync.mockImplementation(() => { throw new Error('cleanup failed'); });
  await expect(d.service.withDownloadedBackup('file', async () => 'consumed')).rejects.toThrow('cleanup failed');
});

test('failed consumption remains the cause even when cleanup fails', async () => {
  const d = download();
  const error = new Error('consumer failed');
  d.fs.rmSync.mockImplementation(() => { throw new Error('cleanup failed'); });
  await expect(d.service.withDownloadedBackup('file', async () => { throw error; })).rejects.toBe(error);
  expect(error.cleanupError.message).toBe('cleanup failed');
});

test('Drive upload failure is sanitized, propagated and closes its read stream', async () => {
  const d = download();
  d.create.mockRejectedValue(new Error('upload failed access_token=simulated-sensitive-token'));
  await expect(d.service.uploadBackupToDrive('/virtual/backup.sql', 'backup.sql'))
    .rejects.toThrow('upload failed access_token=***');
  expect(d.fs.createReadStream.mock.results[0].value.destroy).toHaveBeenCalledTimes(1);
});

test('a write stream construction failure closes the downloaded source before cleanup', async () => {
  const d = download();
  d.fs.createWriteStream.mockImplementation(() => { throw new Error('stream failed'); });
  await expect(d.service.downloadFromDrive('file')).rejects.toThrow('stream failed');
  expect((await d.get.mock.results[0].value).data.destroy).toHaveBeenCalled();
  expect(d.fs.rmSync).toHaveBeenCalledTimes(1);
});

test('a stream destruction failure cannot replace a Drive upload failure', async () => {
  const d = download();
  d.create.mockRejectedValue(new Error('upload failed'));
  d.fs.createReadStream.mockReturnValue({ destroy: () => { throw new Error('stream cleanup failed'); } });
  const error = await d.service.uploadBackupToDrive('/virtual/backup.sql', 'backup.sql').catch(e => e);
  expect(error.message).toBe('Google Drive : upload failed');
  expect(error.cause.message).toBe('upload failed');
  expect(error.cleanupError.message).toBe('stream cleanup failed');
});
