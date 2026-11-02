const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { randomUUID } = require('crypto');
const logger = require('../utils/logger');
const { sanitizeError, sanitizeMessage } = require('../utils/sanitizeLogData');

const execFileAsync = promisify(execFile);
const backupsDir = path.resolve(__dirname, '..', '..', 'backups');

function ensureBackupDirectory() {
  fs.mkdirSync(backupsDir, { recursive: true, mode: 0o700 });
  const stats = fs.lstatSync(backupsDir);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error('Répertoire de sauvegarde invalide.');
  }
  fs.chmodSync(backupsDir, 0o700);
}

function buildBackupFilename() {
  const now = new Date();
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  return `teamoff_backup_${stamp}_${randomUUID()}.sql`;
}

const legacyName = /^teamoff_backup_\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.sql$/;
const publishedName = /^teamoff_backup_\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.sql$/;
const markerPath = filename => path.join(backupsDir, `.${filename}.published.json`);

function assertRegularFile(fd) {
  const stats = fs.fstatSync(fd);
  if (!stats.isFile() || stats.size === 0) throw new Error('Sauvegarde absente, vide ou non ordinaire.');
  return stats;
}

function readSection(fd, position, length) {
  const buffer = Buffer.alloc(length);
  return buffer.subarray(0, fs.readSync(fd, buffer, 0, length, position)).toString('utf8');
}

function validateDump(fd) {
  const stats = assertRegularFile(fd);
  const header = readSection(fd, 0, Math.min(stats.size, 4096));
  const tailLength = Math.min(stats.size, 65536);
  const tail = readSection(fd, stats.size - tailLength, tailLength);
  if (!/^-- PostgreSQL database dump\r?$/m.test(header) ||
      !/(?:^|\n)-- PostgreSQL database dump complete\r?\n--\s*(?:\\unrestrict [a-zA-Z0-9]+\s*)?$/.test(tail)) {
    throw new Error('Sauvegarde SQL incomplète ou format pg_dump invalide.');
  }
  return stats;
}

function cleanupPartial(directory, error) {
  try {
    fs.rmSync(directory, { recursive: true, force: true });
  } catch (cleanupError) {
    sanitizeError(cleanupError);
    logger.error('backup_partial_cleanup_failed', { error: cleanupError.message });
    if (!error) throw cleanupError;
    error.cleanupError = cleanupError;
  }
}

function closeFile(fd, primaryError) {
  try {
    fs.closeSync(fd);
  } catch (cleanupError) {
    sanitizeError(cleanupError);
    logger.error('backup_descriptor_cleanup_failed', { error: cleanupError.message });
    if (!primaryError) throw cleanupError;
    primaryError.cleanupError = cleanupError;
  }
}

function readBackupFile(filePath, read) {
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let primaryError;
  try {
    return read(fd);
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    closeFile(fd, primaryError);
  }
}

function getPgDumpCandidates() {
  if (process.env.PG_DUMP_BIN) {
    return [process.env.PG_DUMP_BIN];
  }
  const candidates = [
    '/usr/bin/pg_dump',           // Linux standard (Render, Ubuntu)
    '/usr/local/bin/pg_dump',
    '/Applications/Postgres.app/Contents/Versions/latest/bin/pg_dump',
    '/Applications/Postgres.app/Contents/Versions/17/bin/pg_dump',
    '/opt/homebrew/bin/pg_dump',
    'pg_dump',
  ].filter(Boolean);

  return [...new Set(candidates)].filter((binPath) => {
    if (binPath === 'pg_dump') {
      return true;
    }
    return fs.existsSync(binPath);
  });
}

async function runDatabaseBackup() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    const error = new Error('DATABASE_URL est manquante.');
    error.statusCode = 500;
    throw error;
  }

  const filename = buildBackupFilename();
  const filePath = path.join(backupsDir, filename);
  let directory;
  let published = false;
  let markerCreated = false;
  try {
    const parsedUrl = new URL(databaseUrl);
    const databaseName = decodeURIComponent(parsedUrl.pathname.replace(/^\//, ''));
    const username = decodeURIComponent(parsedUrl.username || '');
    const password = decodeURIComponent(parsedUrl.password || '');
    const host = parsedUrl.hostname;
    const port = parsedUrl.port || '5432';

    if (!databaseName || !username || !host) {
      throw new Error('DATABASE_URL invalide pour pg_dump.');
    }

    ensureBackupDirectory();
    directory = fs.mkdtempSync(path.join(backupsDir, '.pending-'));
    fs.chmodSync(directory, 0o700);
    const pendingPath = path.join(directory, 'dump.partial');
    const reservation = fs.openSync(pendingPath, 'wx', 0o600);
    closeFile(reservation);

    const childEnv = {
      ...process.env,
      PGPASSWORD: password,
    };

    const sslMode = parsedUrl.searchParams.get('sslmode');
    if (sslMode) {
      childEnv.PGSSLMODE = sslMode;
    }

    const pgDumpArgs = [
      '--format=plain',
      '--no-owner',
      '--no-privileges',
      '--clean',
      '--if-exists',
      '--host',
      host,
      '--port',
      String(port),
      '--username',
      username,
      '--dbname',
      databaseName,
      '--file',
      pendingPath,
    ];

    const candidates = getPgDumpCandidates();
    let lastError = new Error('Aucun binaire pg_dump disponible.');

    for (const pgDumpBin of candidates) {
      try {
        await execFileAsync(pgDumpBin, pgDumpArgs, { env: childEnv });
        lastError = null;
        break;
      } catch (execError) {
        lastError = execError;
        if (!['ENOENT', 'EACCES'].includes(execError.code) || process.env.PG_DUMP_BIN) {
          break;
        }
      }
    }

    if (lastError) {
      const notFound = candidates.length === 0 ||
        (lastError.code === 'ENOENT' || lastError.code === 'EACCES');
      if (notFound) {
        const err = new Error('pg_dump introuvable sur le serveur. Définissez la variable d\'environnement PG_DUMP_BIN avec le chemin complet vers pg_dump.');
        err.statusCode = 500;
        throw err;
      }
      throw lastError;
    }

    const stats = readBackupFile(pendingPath, fd => {
      const validated = validateDump(fd);
      fs.fchmodSync(fd, 0o600);
      fs.fsyncSync(fd);
      return validated;
    });

    const marker = {
      version: 1, filename, sizeBytes: stats.size,
      dev: stats.dev, ino: stats.ino, mtimeMs: stats.mtimeMs,
    };
    fs.writeFileSync(markerPath(filename), JSON.stringify(marker), { flag: 'wx', mode: 0o600 });
    markerCreated = true;
    // A hard link publishes atomically and fails with EEXIST; rename would overwrite.
    fs.linkSync(pendingPath, filePath);
    published = true;
    cleanupPartial(directory);
    directory = undefined;

    return {
      filename,
      filePath,
      sizeBytes: stats.size,
      createdAt: new Date().toISOString(),
    };
  } catch (error) {
    sanitizeError(error);
    if (directory) cleanupPartial(directory, error);
    if (markerCreated && !published) {
      try {
        fs.unlinkSync(markerPath(filename));
      } catch (cleanupError) {
        sanitizeError(cleanupError);
        logger.error('backup_marker_cleanup_failed', { error: cleanupError.message });
        error.cleanupError = cleanupError;
      }
    }
    const detail = sanitizeMessage(error.stderr || error.message || '').trim();
    const mapped = new Error(`Echec de la sauvegarde PostgreSQL: ${detail || 'Erreur inconnue.'}`, { cause: error });
    mapped.statusCode = 500;
    mapped.code = error.code;
    mapped.cleanupError = error.cleanupError;
    if (published) mapped.publishedFilename = filename;
    throw mapped;
  }
}

function assertRestoreAvailable() {
  const error = new Error('Restauration indisponible : un exécuteur administratif local séparé doit être installé et autorisé. Aucune restauration exécutée.');
  error.statusCode = 503;
  error.code = 'RESTORE_EXECUTOR_UNAVAILABLE';
  throw error;
}

async function restoreFromFile() {
  assertRestoreAvailable();
}

function getBackupPathByFilename(filename) {
  if (typeof filename !== 'string' || (!legacyName.test(filename) && !publishedName.test(filename))) {
    return null;
  }
  return path.join(backupsDir, filename);
}

function openPublishedBackup(filename) {
  const filePath = getBackupPathByFilename(filename);
  if (!filePath) throw Object.assign(new Error('Nom de fichier invalide.'), { statusCode: 400 });
  let fd;
  try {
    ensureBackupDirectory();
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Sauvegarde non ordinaire.');
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stats = validateDump(fd);
    if (publishedName.test(filename)) {
      const marker = readBackupFile(markerPath(filename), markerFd => {
        const markerStats = assertRegularFile(markerFd);
        if (markerStats.size > 4096) throw new Error('Marqueur de publication invalide.');
        return JSON.parse(readSection(markerFd, 0, markerStats.size));
      });
      if (marker.version !== 1 || marker.filename !== filename ||
          marker.sizeBytes !== stats.size || marker.ino !== stats.ino ||
          marker.dev !== stats.dev || marker.mtimeMs !== stats.mtimeMs) {
        throw new Error('Sauvegarde non publiée ou modifiée depuis sa validation.');
      }
    }
    fs.fchmodSync(fd, 0o600);
    return { fd, filePath, filename, sizeBytes: stats.size, mtimeMs: stats.mtimeMs };
  } catch (error) {
    if (fd !== undefined) closeFile(fd, error);
    const mapped = new Error('Sauvegarde introuvable ou non validée.', { cause: sanitizeError(error) });
    mapped.statusCode = ['ENOENT', 'ELOOP'].includes(error.code) || !error.code ? 404 : 500;
    mapped.code = error.code;
    mapped.cleanupError = error.cleanupError;
    throw mapped;
  }
}

/**
 * Supprime les fichiers de backup plus vieux que retentionDays jours.
 * @param {number} retentionDays
 * @returns {{ deleted: string[], kept: number }}
 */
function cleanupOldBackups(retentionDays = 7) {
  ensureBackupDirectory();
  const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const files = fs.readdirSync(backupsDir).filter((f) => getBackupPathByFilename(f));
  const deleted = [];
  const errors = [];

  for (const file of files) {
    const filePath = path.join(backupsDir, file);
    try {
      const stats = fs.lstatSync(filePath);
      if (stats.isFile() && !stats.isSymbolicLink() && stats.mtimeMs < cutoffMs) {
        fs.unlinkSync(filePath);
        deleted.push(file);
        if (publishedName.test(file)) {
          try {
            fs.unlinkSync(markerPath(file));
          } catch (error) {
            if (error.code !== 'ENOENT') throw error;
          }
        }
      }
    } catch (error) {
      sanitizeError(error);
      errors.push({ filename: file, message: error.message });
      logger.error('backup_retention_cleanup_failed', { filename: file, error: error.message });
    }
  }

  if (errors.length) {
    const error = new Error('Nettoyage des sauvegardes incomplet.');
    error.details = errors;
    throw error;
  }
  return { deleted, kept: files.length - deleted.length };
}

module.exports = {
  backupsDir,
  runDatabaseBackup,
  restoreFromFile,
  assertRestoreAvailable,
  getBackupPathByFilename,
  openPublishedBackup,
  cleanupOldBackups,
};