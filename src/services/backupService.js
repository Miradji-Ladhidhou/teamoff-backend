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
      const notFound = candidates.length === 0 ||
        (lastError.code === 'ENOENT' || lastError.code === 'EACCES');
      if (notFound) {
        const err = new Error('pg_dump introuvable sur le serveur. Définissez la variable d\'environnement PG_DUMP_BIN avec le chemin complet vers pg_dump.');
        err.statusCode = 500;
        throw err;
      }
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

// Supprime les statements EVENT TRIGGER du SQL (pgrst_drop_watch etc. sont
// créés par PostgREST/Render avec un superuser — l'app user n'en est pas propriétaire).
function stripEventTriggers(content) {
  const lines = content.split('\n');
  const result = [];
  let skip = false;

  for (const line of lines) {
    const upper = line.trim().toUpperCase();
    if (
      upper.startsWith('DROP EVENT TRIGGER') ||
      upper.startsWith('CREATE EVENT TRIGGER') ||
      upper.startsWith('ALTER EVENT TRIGGER')
    ) {
      skip = true;
    }
    if (!skip) result.push(line);
    if (skip && upper.includes(';')) skip = false;
  }

  return result.join('\n');
}

async function restoreFromFile(filePath) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    const err = new Error('DATABASE_URL est manquante.');
    err.statusCode = 500;
    throw err;
  }

  if (!fs.existsSync(filePath)) {
    const err = new Error('Fichier de sauvegarde introuvable.');
    err.statusCode = 404;
    throw err;
  }

  // Écrire une version filtrée sans les EVENT TRIGGERs
  const strippedPath = filePath + '.stripped.sql';
  const strippedContent = stripEventTriggers(fs.readFileSync(filePath, 'utf8'));
  fs.writeFileSync(strippedPath, strippedContent);

  const parsedUrl = new URL(databaseUrl);
  const databaseName = parsedUrl.pathname.replace(/^\//, '');
  const username = decodeURIComponent(parsedUrl.username || '');
  const password = decodeURIComponent(parsedUrl.password || '');
  const host = parsedUrl.hostname;
  const port = parsedUrl.port || '5432';

  const childEnv = { ...process.env, PGPASSWORD: password };
  const sslMode = parsedUrl.searchParams.get('sslmode');
  if (sslMode) childEnv.PGSSLMODE = sslMode;

  // Sans --single-transaction ni ON_ERROR_STOP : psql continue malgré les
  // erreurs "must be owner of" sur les objets d'extension Render (vector_indexes,
  // pgrst_drop_watch…). On échoue seulement si des erreurs non liées aux permissions
  // sont détectées dans stderr.
  const psqlArgs = [
    '--host', host,
    '--port', String(port),
    '--username', username,
    '--dbname', databaseName,
    '--file', strippedPath,
  ];

  const psqlCandidates = [
    process.env.PSQL_BIN,
    '/opt/homebrew/bin/psql',
    '/usr/local/bin/psql',
    'psql',
  ].filter(Boolean);

  let lastError = null;
  try {
    for (const bin of psqlCandidates) {
      try {
        await execFileAsync(bin, psqlArgs, { env: childEnv });
        lastError = null;
        break;
      } catch (e) {
        // psql exit non-zero : vérifier si c'est uniquement des erreurs de permission
        // sur des objets d'extension (attendues sur Render managed PostgreSQL)
        const stderr = (e.stderr || e.message || '').toString();
        const errorLines = stderr.split('\n').filter((l) => /^psql:.*ERROR:/i.test(l));
        const onlyPermissionErrors = errorLines.length > 0 && errorLines.every((l) =>
          l.includes('must be owner of') ||
          l.includes('already exists') ||
          l.includes('does not exist')
        );
        if (onlyPermissionErrors) {
          lastError = null; // erreurs bénignes — restauration considérée réussie
          break;
        }
        lastError = e;
      }
    }
  } finally {
    try { fs.unlinkSync(strippedPath); } catch { /* ignore */ }
  }

  if (lastError) {
    const detail = (lastError.stderr || lastError.message || '').toString().trim();
    const err = new Error(`Échec de la restauration : ${detail || 'Erreur inconnue.'}`);
    err.statusCode = 500;
    throw err;
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
  restoreFromFile,
  getBackupPathByFilename,
  cleanupOldBackups,
};