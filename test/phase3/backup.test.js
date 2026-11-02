'use strict';

const path = require('path');
const { promisify } = require('util');
const { loadSource } = require('./loadSource');

const dump = '--\n-- PostgreSQL database dump\n--\n\nSELECT 1;\n\n--\n-- PostgreSQL database dump complete\n--\n';
const oldFilename = 'teamoff_backup_2026-11-01T12-00-00-000Z.sql';

function backup(outcomes = [], env = {}) {
  const files = new Map();
  const descriptors = new Map();
  let sequence = 0;
  const failure = code => Object.assign(new Error(code), { code });
  const entry = file => {
    if (!files.has(file)) throw failure('ENOENT');
    return files.get(file);
  };
  const stats = node => ({
    size: node.content.length, ino: node.ino, dev: 1, mtimeMs: 1,
    isFile: () => node.type === 'file', isDirectory: () => node.type === 'dir',
    isSymbolicLink: () => node.type === 'symlink',
  });
  const put = (file, content = '', type = 'file') => {
    files.set(file, { content: Buffer.from(content), type, ino: ++sequence, mode: 0o644 });
  };
  const fs = {
    constants: { O_RDONLY: 0, O_NOFOLLOW: 0x20000 },
    mkdirSync: jest.fn(file => { if (!files.has(file)) put(file, '', 'dir'); }),
    existsSync: jest.fn().mockReturnValue(true),
    lstatSync: jest.fn(file => stats(entry(file))),
    statSync: jest.fn(file => stats(entry(file))),
    chmodSync: jest.fn((file, mode) => { entry(file).mode = mode; }),
    mkdtempSync: jest.fn(prefix => { const dir = `${prefix}${++sequence}`; put(dir, '', 'dir'); return dir; }),
    openSync: jest.fn((file, flags, mode) => {
      if (flags === 'wx') {
        if (files.has(file)) throw failure('EEXIST');
        put(file);
        entry(file).mode = mode;
      }
      const node = entry(file);
      if (node.type === 'symlink') throw failure('ELOOP');
      const fd = ++sequence;
      descriptors.set(fd, node);
      return fd;
    }),
    closeSync: jest.fn(fd => { descriptors.delete(fd); }),
    fstatSync: jest.fn(fd => stats(descriptors.get(fd))),
    fchmodSync: jest.fn((fd, mode) => { descriptors.get(fd).mode = mode; }),
    fsyncSync: jest.fn(),
    readSync: jest.fn((fd, buffer, offset, length, position) =>
      descriptors.get(fd).content.copy(buffer, offset, position, position + length)),
    writeFileSync: jest.fn((file, content, options) => {
      if (options?.flag === 'wx' && files.has(file)) throw failure('EEXIST');
      put(file, content);
      entry(file).mode = options?.mode;
    }),
    linkSync: jest.fn((from, to) => {
      if (files.has(to)) throw failure('EEXIST');
      files.set(to, entry(from));
    }),
    unlinkSync: jest.fn(file => { entry(file); files.delete(file); }),
    rmSync: jest.fn(dir => {
      for (const file of files.keys()) if (file === dir || file.startsWith(`${dir}/`)) files.delete(file);
    }),
    readdirSync: jest.fn(dir => [...files.keys()].filter(f => path.dirname(f) === dir).map(f => path.basename(f))),
  };
  const execFile = jest.fn((bin, args, options, callback) => {
    const error = outcomes.shift();
    entry(args[args.indexOf('--file') + 1]).content = Buffer.from(error ? 'partial dump' : dump);
    callback(error || null, '', '');
  });
  const randomUUID = jest.fn(require('crypto').randomUUID);
  const logger = { error: jest.fn() };
  const loaded = loadSource('src/services/backupService.js', {
    fs, path, child_process: { execFile }, util: { promisify },
    crypto: { randomUUID }, '../utils/logger': logger,
    '../utils/sanitizeLogData': require('../../src/utils/sanitizeLogData'),
  }, { process: { env: { DATABASE_URL: 'postgresql://app:fake@localhost:5432/copy', ...env } } });
  return { ...loaded.exports, fs, execFile, files, descriptors, put, randomUUID, logger };
}

test.each(['present.sql', '../source.sql', undefined])('restore %s is refused before any IO or process', async file => {
  const b = backup();
  await expect(b.restoreFromFile(file)).rejects.toMatchObject({ statusCode: 503, code: 'RESTORE_EXECUTOR_UNAVAILABLE' });
  expect(b.execFile).not.toHaveBeenCalled();
  for (const method of Object.values(b.fs).filter(v => typeof v === 'function')) expect(method).not.toHaveBeenCalled();
});

test('restore availability is explicit even without DATABASE_URL', () => {
  const b = backup([], { DATABASE_URL: undefined });
  expect(() => b.assertRestoreAvailable()).toThrow(/exécuteur administratif local séparé/);
  expect(b.execFile).not.toHaveBeenCalled();
});

test('backup retains dump format and returns actual metadata', async () => {
  const b = backup();
  const result = await b.runDatabaseBackup();
  expect(result.sizeBytes).toBe(Buffer.byteLength(dump));
  expect(b.execFile).toHaveBeenCalledTimes(1);
  const [, args, options] = b.execFile.mock.calls[0];
  expect(args).toEqual(expect.arrayContaining(['--format=plain', '--no-owner', '--no-privileges', '--clean', '--if-exists']));
  expect(args.join(' ')).not.toContain('fake');
  expect(options.env.PGPASSWORD).toBe('fake');
});

test.each([1, 'ECONNRESET'])('dump failure %s does not trigger retries or success', async code => {
  const b = backup([Object.assign(new Error('dump failed'), { code })]);
  await expect(b.runDatabaseBackup()).rejects.toThrow(/dump failed/);
  expect(b.execFile).toHaveBeenCalledTimes(1);
  expect(b.fs.statSync).not.toHaveBeenCalled();
  expect(b.fs.linkSync).not.toHaveBeenCalled();
  expect([...b.files.keys()].some(f => f.endsWith('.partial'))).toBe(false);
});

test('fallback is limited to missing executable before dump execution', async () => {
  const b = backup([Object.assign(new Error('missing'), { code: 'ENOENT' })]);
  await b.runDatabaseBackup();
  expect(b.execFile).toHaveBeenCalledTimes(2);
});

test('explicit dump binary is not silently replaced', async () => {
  const b = backup([Object.assign(new Error('missing'), { code: 'ENOENT' })], { PG_DUMP_BIN: '/chosen/pg_dump' });
  await expect(b.runDatabaseBackup()).rejects.toThrow(/pg_dump introuvable/);
  expect(b.execFile).toHaveBeenCalledTimes(1);
});

test('missing backup URL fails before IO', async () => {
  const b = backup([], { DATABASE_URL: undefined });
  await expect(b.runDatabaseBackup()).rejects.toThrow(/DATABASE_URL/);
  expect(b.execFile).not.toHaveBeenCalled();
  expect(b.fs.mkdirSync).not.toHaveBeenCalled();
});

test('two simultaneous dumps use separate exclusive pending files and unique publications', async () => {
  const b = backup();
  const results = await Promise.all([b.runDatabaseBackup(), b.runDatabaseBackup()]);
  expect(new Set(results.map(r => r.filename)).size).toBe(2);
  const pending = b.execFile.mock.calls.map(([, args]) => args[args.indexOf('--file') + 1]);
  expect(new Set(pending).size).toBe(2);
  expect(pending.every(f => f.endsWith('/dump.partial'))).toBe(true);
  expect(b.fs.openSync.mock.calls.filter(([, flags]) => flags === 'wx')).toHaveLength(2);
  for (const r of results) {
    expect(b.files.get(r.filePath).mode).toBe(0o600);
    const opened = b.openPublishedBackup(r.filename);
    expect(opened.sizeBytes).toBe(Buffer.byteLength(dump));
    b.fs.closeSync(opened.fd);
  }
  expect(b.files.get(b.backupsDir).mode).toBe(0o700);
});

test('publication never overwrites an existing destination even after a name collision', async () => {
  const b = backup();
  const originalLink = b.fs.linkSync.getMockImplementation();
  b.fs.linkSync.mockImplementation((from, to) => {
    b.put(to, 'original existing file');
    originalLink(from, to);
  });
  await expect(b.runDatabaseBackup()).rejects.toMatchObject({ code: 'EEXIST' });
  const destination = b.fs.linkSync.mock.calls[0][1];
  expect(b.files.get(destination).content.toString()).toBe('original existing file');
  expect([...b.files.keys()].some(f => f.endsWith('.published.json'))).toBe(false);
});

test('a colliding publication marker cannot overwrite a previously published backup', async () => {
  const b = backup();
  const originalWrite = b.fs.writeFileSync.getMockImplementation();
  b.fs.writeFileSync.mockImplementation((file, content, options) => {
    b.put(file, 'existing marker');
    originalWrite(file, content, options);
  });
  await expect(b.runDatabaseBackup()).rejects.toMatchObject({ code: 'EEXIST' });
  expect(b.fs.linkSync).not.toHaveBeenCalled();
  expect(b.files.get(b.fs.writeFileSync.mock.calls[0][0]).content.toString()).toBe('existing marker');
});

test('even exit zero cannot publish an incomplete dump', async () => {
  const b = backup();
  b.execFile.mockImplementation((bin, args, options, callback) => {
    b.files.get(args[args.indexOf('--file') + 1]).content = Buffer.from('-- PostgreSQL database dump\npartial');
    callback(null, '', '');
  });
  await expect(b.runDatabaseBackup()).rejects.toThrow(/incomplète/);
  expect(b.fs.linkSync).not.toHaveBeenCalled();
  expect([...b.files.keys()].some(f => f.endsWith('.partial'))).toBe(false);
});

test('cleanup failure leaves only isolated partial data and preserves the original error', async () => {
  const primary = new Error('dump failed');
  const b = backup([primary]);
  b.fs.rmSync.mockImplementation(() => { throw new Error('cleanup failed'); });
  const error = await b.runDatabaseBackup().catch(e => e);
  expect(error.message).toContain('dump failed');
  expect(error.cause).toBe(primary);
  expect(error.cleanupError.message).toBe('cleanup failed');
  expect(b.logger.error).toHaveBeenCalledWith('backup_partial_cleanup_failed', { error: 'cleanup failed' });
  const partial = [...b.files.keys()].find(f => f.endsWith('.partial'));
  expect(partial).toContain('/.pending-');
  expect(b.getBackupPathByFilename(path.basename(partial))).toBeNull();
});

test('cleanup failure after publication still returns an explicit failure', async () => {
  const b = backup();
  b.fs.rmSync.mockImplementation(() => { throw new Error('cleanup failed'); });
  const error = await b.runDatabaseBackup().catch(e => e);
  expect(error.statusCode).toBe(500);
  expect(error.message).toContain('cleanup failed');
  expect(error.publishedFilename).toBeDefined();
});

test('historic complete plain dumps remain downloadable with restrictive permissions', () => {
  const b = backup();
  b.put(b.backupsDir, '', 'dir');
  b.put(path.join(b.backupsDir, oldFilename), dump);
  const opened = b.openPublishedBackup(oldFilename);
  expect(opened.sizeBytes).toBe(Buffer.byteLength(dump));
  expect(b.files.get(opened.filePath).mode).toBe(0o600);
  b.fs.closeSync(opened.fd);
  expect(b.descriptors.size).toBe(0);
});

test.each(['symlink', 'dir', 'absent', 'incomplete'])('%s backup is never downloadable', kind => {
  const b = backup();
  if (kind !== 'absent') b.put(path.join(b.backupsDir, oldFilename), kind === 'incomplete' ? 'partial' : dump, kind === 'symlink' ? 'symlink' : kind === 'dir' ? 'dir' : 'file');
  expect(() => b.openPublishedBackup(oldFilename)).toThrow(/non validée/);
  expect(b.descriptors.size).toBe(0);
});

test('a complete UUID-named file without publication marker is refused', () => {
  const b = backup();
  const filename = oldFilename.replace('.sql', '_12345678-1234-1234-1234-123456789abc.sql');
  b.put(path.join(b.backupsDir, filename), dump);
  expect(() => b.openPublishedBackup(filename)).toThrow(/non validée/);
  expect(b.descriptors.size).toBe(0);
});

test('a published file modified after validation is refused', async () => {
  const b = backup();
  const result = await b.runDatabaseBackup();
  b.files.get(result.filePath).content = Buffer.from(`${dump}tampered`);
  expect(() => b.openPublishedBackup(result.filename)).toThrow(/non validée/);
});

test.each(['..', '.', '../dump.sql', 'dump.partial', 'unpublished.sql'])('invalid name %s cannot leave publication namespace', filename => {
  const b = backup();
  expect(() => b.openPublishedBackup(filename)).toThrow('Nom de fichier invalide');
  expect(b.fs.openSync).not.toHaveBeenCalled();
});

test('symlink publication markers are refused', async () => {
  const b = backup();
  const result = await b.runDatabaseBackup();
  b.files.get(path.join(b.backupsDir, `.${result.filename}.published.json`)).type = 'symlink';
  expect(() => b.openPublishedBackup(result.filename)).toThrow(/non validée/);
  expect(b.descriptors.size).toBe(0);
});

test('symlink backup directory is refused before launching pg_dump', async () => {
  const b = backup();
  b.put(b.backupsDir, '', 'symlink');
  await expect(b.runDatabaseBackup()).rejects.toThrow(/Répertoire de sauvegarde invalide/);
  expect(b.execFile).not.toHaveBeenCalled();
});

test('dump secrets are removed from the main error, cause and stderr', async () => {
  const b = backup([Object.assign(new Error('password=synthetic-secret'), {
    stderr: 'postgres://runner:synthetic-secret@localhost/copy token=synthetic-token',
  })]);
  const error = await b.runDatabaseBackup().catch(e => e);
  for (const text of [error.message, error.stack, error.cause.message, error.cause.stderr, error.cause.stack]) {
    expect(text).not.toContain('synthetic-secret');
    expect(text).not.toContain('synthetic-token');
  }
});

test('retention reports cleanup errors rather than silently succeeding', () => {
  const b = backup();
  b.put(path.join(b.backupsDir, oldFilename), dump);
  b.fs.unlinkSync.mockImplementation(() => { throw new Error('unlink failed password=synthetic-secret'); });
  expect(() => b.cleanupOldBackups(0)).toThrow('Nettoyage des sauvegardes incomplet');
  expect(b.logger.error).toHaveBeenCalledWith('backup_retention_cleanup_failed', expect.objectContaining({
    error: 'unlink failed password=***',
  }));
});

test('identical timestamps and UUID collisions cannot overwrite a successful backup', async () => {
  const b = backup();
  b.randomUUID.mockReturnValue('12345678-1234-1234-1234-123456789abc');
  const clock = jest.spyOn(Date.prototype, 'toISOString').mockReturnValue('2026-11-01T12:00:00.000Z');
  try {
    const original = await b.runDatabaseBackup();
    const node = b.files.get(original.filePath);
    const markerFile = path.join(b.backupsDir, `.${original.filename}.published.json`);
    const marker = b.files.get(markerFile);
    await expect(b.runDatabaseBackup()).rejects.toMatchObject({ code: 'EEXIST' });
    expect(b.files.get(original.filePath)).toBe(node);
    expect(b.files.get(markerFile)).toBe(marker);
    expect(b.fs.linkSync).toHaveBeenCalledTimes(1);
  } finally {
    clock.mockRestore();
  }
});

test('historic dump with unrestrict terminator remains compatible', () => {
  const b = backup();
  b.put(path.join(b.backupsDir, oldFilename), `\\restrict example123\n${dump}\n\\unrestrict example123\n\n`);
  const opened = b.openPublishedBackup(oldFilename);
  b.fs.closeSync(opened.fd);
});

test('a completion comment inside an unfinished historical dump is not accepted', () => {
  const b = backup();
  b.put(path.join(b.backupsDir, oldFilename), `${dump}\nINSERT INTO unfinished VALUES (`);
  expect(() => b.openPublishedBackup(oldFilename)).toThrow(/non validée/);
});

test('a file descriptor close failure does not mask validation failure', () => {
  const b = backup();
  b.put(path.join(b.backupsDir, oldFilename), 'partial dump');
  b.fs.closeSync.mockImplementation(() => { throw new Error('close failed'); });
  const error = (() => { try { b.openPublishedBackup(oldFilename); } catch (e) { return e; } })();
  expect(error.cause.message).toContain('incomplète');
  expect(error.cleanupError.message).toBe('close failed');
  expect(b.logger.error).toHaveBeenCalledWith('backup_descriptor_cleanup_failed', { error: 'close failed' });
});

test('retention removes both completed backup and its publication marker', async () => {
  const b = backup();
  const result = await b.runDatabaseBackup();
  const cleanup = b.cleanupOldBackups(0);
  expect(cleanup.deleted).toEqual([result.filename]);
  expect(b.files.has(result.filePath)).toBe(false);
  expect(b.files.has(path.join(b.backupsDir, `.${result.filename}.published.json`))).toBe(false);
});

test('directory permission failure is explicit and happens before pg_dump', async () => {
  const b = backup();
  b.fs.chmodSync.mockImplementation(() => { throw Object.assign(new Error('permission denied'), { code: 'EACCES' }); });
  await expect(b.runDatabaseBackup()).rejects.toThrow('permission denied');
  expect(b.execFile).not.toHaveBeenCalled();
});

test('file permission failure never publishes a dump', async () => {
  const b = backup();
  b.fs.fchmodSync.mockImplementation(() => { throw new Error('permission denied'); });
  await expect(b.runDatabaseBackup()).rejects.toThrow('permission denied');
  expect(b.fs.linkSync).not.toHaveBeenCalled();
  expect([...b.files.keys()].some(f => f.endsWith('.partial'))).toBe(false);
});
