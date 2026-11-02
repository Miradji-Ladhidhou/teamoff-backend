'use strict';

const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { pipeline } = require('stream/promises');
const logger = require('../utils/logger');
const { sanitizeError, sanitizeMessage } = require('../utils/sanitizeLogData');

function cleanupDirectory(directory, primaryError) {
  try {
    fs.rmSync(directory, { recursive: true, force: true });
  } catch (cleanupError) {
    sanitizeError(cleanupError);
    logger.error('drive_temporary_cleanup_failed', { error: cleanupError.message });
    if (!primaryError) throw cleanupError;
    primaryError.cleanupError = cleanupError;
  }
}

function destroyStream(stream, primaryError) {
  try {
    stream?.destroy();
  } catch (cleanupError) {
    sanitizeError(cleanupError);
    logger.error('drive_stream_cleanup_failed', { error: cleanupError.message });
    if (!primaryError) throw cleanupError;
    primaryError.cleanupError = cleanupError;
  }
}

async function getDriveClient() {
  const clientId     = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    const err = new Error('GOOGLE_OAUTH_CLIENT_ID et GOOGLE_OAUTH_CLIENT_SECRET sont requis.');
    err.statusCode = 503;
    throw err;
  }

  // 1. Token stocké en DB via le flux OAuth in-app (prioritaire)
  let refreshToken = null;
  try {
    const { SystemSetting } = require('../models');
    const { decryptTotpSecret } = require('../utils/totpCrypto');
    const setting = await SystemSetting.findOne({ where: { key: 'google_drive_oauth' } });
    if (setting?.data?.refresh_token_enc) {
      refreshToken = decryptTotpSecret(setting.data.refresh_token_enc);
    }
  } catch { /* fallback env */ }

  // 2. Fallback : variable d'environnement
  if (!refreshToken) refreshToken = process.env.GOOGLE_OAUTH_REFRESH_TOKEN || null;

  if (!refreshToken) {
    const err = new Error('Google Drive non configuré. Connectez votre compte depuis Paramètres → Base de données.');
    err.statusCode = 503;
    throw err;
  }

  const callbackUrl = `${(process.env.BACKEND_URL || 'http://localhost:3000').replace(/\/$/, '')}/api/google-drive/callback`;
  const auth = new google.auth.OAuth2(clientId, clientSecret, callbackUrl);
  auth.setCredentials({ refresh_token: refreshToken });
  return google.drive({ version: 'v3', auth });
}

async function uploadBackupToDrive(filePath, filename) {
  const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
  if (!folderId) {
    const err = new Error('GOOGLE_DRIVE_FOLDER_ID est manquant dans les variables d\'environnement.');
    err.statusCode = 500;
    throw err;
  }

  const drive = await getDriveClient();

  const fileMetadata = {
    name: filename,
    parents: [folderId],
  };

  const media = {
    mimeType: 'application/octet-stream',
    body: fs.createReadStream(filePath),
  };

  let primaryError;
  try {
    const response = await drive.files.create({
      resource: fileMetadata,
      media,
      fields: 'id, name, size, webViewLink, createdTime',
    });
    return response.data;
  } catch (e) {
    const msg = sanitizeMessage(e.message || 'Erreur Google Drive inconnue');
    const gErr = new Error(`Google Drive : ${msg}`, { cause: sanitizeError(e) });
    gErr.statusCode = 500;
    primaryError = gErr;
    throw gErr;
  } finally {
    destroyStream(media.body, primaryError);
  }
}

async function listDriveBackups(maxResults = 20) {
  const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
  if (!folderId) return [];

  const drive = await getDriveClient();

  let response;
  try {
    response = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'files(id, name, size, createdTime, webViewLink)',
      orderBy: 'createdTime desc',
      pageSize: maxResults,
    });
  } catch (error) {
    throw sanitizeError(error);
  }

  return response.data.files || [];
}

async function downloadFromDrive(fileId) {
  const drive = await getDriveClient();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'teamoff-restore-'));
  const destPath = path.join(directory, 'backup.sql');
  let source;
  try {
    fs.chmodSync(directory, 0o700);
    const response = await drive.files.get(
      { fileId, alt: 'media' },
      { responseType: 'stream' }
    );
    source = response.data;
    await pipeline(source, fs.createWriteStream(destPath, { flags: 'wx', mode: 0o600 }));
    fs.chmodSync(destPath, 0o600);
    temporaryDownloads.set(destPath, directory);
    return destPath;
  } catch (error) {
    sanitizeError(error);
    destroyStream(source, error);
    cleanupDirectory(directory, error);
    throw error;
  }
}

const temporaryDownloads = new Map();

// The successful caller owns this cleanup; only paths allocated here are accepted.
function cleanupDownloadedBackup(filePath) {
  const directory = temporaryDownloads.get(filePath);
  if (!directory) throw new Error('Téléchargement temporaire inconnu.');
  cleanupDirectory(directory);
  temporaryDownloads.delete(filePath);
}

async function withDownloadedBackup(fileId, consume) {
  const filePath = await downloadFromDrive(fileId);
  let primaryError;
  try {
    return await consume(filePath);
  } catch (error) {
    primaryError = sanitizeError(error);
    throw primaryError;
  } finally {
    if (primaryError) {
      const directory = temporaryDownloads.get(filePath);
      if (directory) cleanupDirectory(directory, primaryError);
      if (!primaryError.cleanupError) temporaryDownloads.delete(filePath);
    } else {
      cleanupDownloadedBackup(filePath);
    }
  }
}

module.exports = {
  uploadBackupToDrive, listDriveBackups, downloadFromDrive,
  cleanupDownloadedBackup, withDownloadedBackup,
};
