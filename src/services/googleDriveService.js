'use strict';

const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const os = require('os');

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

  try {
    const response = await drive.files.create({
      resource: fileMetadata,
      media,
      fields: 'id, name, size, webViewLink, createdTime',
    });
    return response.data;
  } catch (e) {
    const msg = e.message || 'Erreur Google Drive inconnue';
    const gErr = new Error(`Google Drive : ${msg}`);
    gErr.statusCode = 500;
    throw gErr;
  }
}

async function listDriveBackups(maxResults = 20) {
  const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
  if (!folderId) return [];

  const drive = await getDriveClient();

  const response = await drive.files.list({
    q: `'${folderId}' in parents and trashed = false`,
    fields: 'files(id, name, size, createdTime, webViewLink)',
    orderBy: 'createdTime desc',
    pageSize: maxResults,
  });

  return response.data.files || [];
}

async function downloadFromDrive(fileId, filename) {
  const drive = await getDriveClient();

  const destPath = path.join(os.tmpdir(), filename || `restore_${Date.now()}.sql`);
  const dest = fs.createWriteStream(destPath);

  const response = await drive.files.get(
    { fileId, alt: 'media' },
    { responseType: 'stream' }
  );

  await new Promise((resolve, reject) => {
    response.data
      .on('error', reject)
      .pipe(dest)
      .on('error', reject)
      .on('finish', resolve);
  });

  return destPath;
}

module.exports = { uploadBackupToDrive, listDriveBackups, downloadFromDrive };
