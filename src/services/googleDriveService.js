'use strict';

const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const os = require('os');

function getDriveClient() {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_OAUTH_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    const err = new Error(
      'Variables Google OAuth manquantes : GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_OAUTH_REFRESH_TOKEN'
    );
    err.statusCode = 500;
    throw err;
  }

  const auth = new google.auth.OAuth2(clientId, clientSecret);
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

  const drive = getDriveClient();

  const fileMetadata = {
    name: filename,
    parents: [folderId],
  };

  const media = {
    mimeType: 'application/octet-stream',
    body: fs.createReadStream(filePath),
  };

  const response = await drive.files.create({
    resource: fileMetadata,
    media,
    fields: 'id, name, size, webViewLink, createdTime',
  });

  return response.data;
}

async function listDriveBackups(maxResults = 20) {
  const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
  if (!folderId) return [];

  const drive = getDriveClient();

  const response = await drive.files.list({
    q: `'${folderId}' in parents and trashed = false`,
    fields: 'files(id, name, size, createdTime, webViewLink)',
    orderBy: 'createdTime desc',
    pageSize: maxResults,
  });

  return response.data.files || [];
}

async function downloadFromDrive(fileId, filename) {
  const drive = getDriveClient();

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
