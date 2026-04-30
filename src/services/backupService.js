const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const backupsDir = path.resolve(__dirname, '..', '..', 'backups');

function ensureBackupDirectory() {
  fs.mkdirSync(backupsDir, { recursive: true });
}

function buildBackupFilename() {
  const now = new Date();
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  return `teamoff_backup_${stamp}.sql`;
}

function getPgDumpCandidates() {
  const candidates = [
    process.env.PG_DUMP_BIN,
    '/Applications/Postgres.app/Contents/Versions/latest/bin/pg_dump',
    '/Applications/Postgres.app/Contents/Versions/17/bin/pg_dump',
    '/opt/homebrew/bin/pg_dump',
    '/usr/local/bin/pg_dump',
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

  ensureBackupDirectory();

  const filename = buildBackupFilename();
  const filePath = path.join(backupsDir, filename);

  try {
    const parsedUrl = new URL(databaseUrl);
    const databaseName = parsedUrl.pathname.replace(/^\//, '');
    const username = decodeURIComponent(parsedUrl.username || '');
    const password = decodeURIComponent(parsedUrl.password || '');
    const host = parsedUrl.hostname;
    const port = parsedUrl.port || '5432';

    if (!databaseName || !username || !host) {
      throw new Error('DATABASE_URL invalide pour pg_dump.');
    }

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
      '--host',
      host,
      '--port',
      String(port),
      '--username',
      username,
      '--dbname',
      databaseName,
      '--file',
      filePath,
    ];

    const candidates = getPgDumpCandidates();
    let lastError = null;

    for (const pgDumpBin of candidates) {
      try {
        await execFileAsync(pgDumpBin, pgDumpArgs, { env: childEnv });
        lastError = null;
        break;
      } catch (execError) {
        lastError = execError;
      }
    }

    if (lastError) {
      throw lastError;
    }

    const stats = fs.statSync(filePath);

    return {
      filename,
      filePath,
      sizeBytes: stats.size,
      createdAt: new Date().toISOString(),
    };
  } catch (error) {
    const detail = (error.stderr || error.message || '').toString().trim();
    const mapped = new Error(`Echec de la sauvegarde PostgreSQL: ${detail || 'Erreur inconnue.'}`);
    mapped.statusCode = 500;
    throw mapped;
  }
}

function getBackupPathByFilename(filename) {
  const safeName = path.basename(filename || '');
  if (!safeName || safeName !== filename) {
    return null;
  }

  return path.join(backupsDir, safeName);
}

/**
 * Supprime les fichiers de backup plus vieux que retentionDays jours.
 * @param {number} retentionDays
 * @returns {{ deleted: string[], kept: number }}
 */
function cleanupOldBackups(retentionDays = 7) {
  ensureBackupDirectory();
  const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const files = fs.readdirSync(backupsDir).filter((f) => f.endsWith('.sql'));
  const deleted = [];

  for (const file of files) {
    const filePath = path.join(backupsDir, file);
    try {
      const stats = fs.statSync(filePath);
      if (stats.mtimeMs < cutoffMs) {
        fs.unlinkSync(filePath);
        deleted.push(file);
      }
    } catch {
      // ignorer les fichiers inaccessibles
    }
  }

  return { deleted, kept: files.length - deleted.length };
}

module.exports = {
  backupsDir,
  runDatabaseBackup,
  getBackupPathByFilename,
  cleanupOldBackups,
};