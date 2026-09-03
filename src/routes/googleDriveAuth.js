'use strict';

const express = require('express');
const router = express.Router();
const { google } = require('googleapis');
const jwt = require('jsonwebtoken');
const { encryptTotpSecret, decryptTotpSecret } = require('../utils/totpCrypto');
const { SystemSetting } = require('../models');
const authJwt = require('../middlewares/authJwt');
const authorizeRole = require('../middlewares/authorizeRole');
const logger = require('../utils/logger');

const SETTING_KEY = 'google_drive_oauth';
const SCOPES = ['https://www.googleapis.com/auth/drive.file'];

function getCallbackUrl() {
  const base = (process.env.BACKEND_URL || 'http://localhost:3000').replace(/\/$/, '');
  return `${base}/api/google-drive/callback`;
}

function getOAuth2Client() {
  const clientId     = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    const err = new Error('GOOGLE_OAUTH_CLIENT_ID et GOOGLE_OAUTH_CLIENT_SECRET sont requis dans les variables d\'environnement.');
    err.statusCode = 503;
    throw err;
  }
  return new google.auth.OAuth2(clientId, clientSecret, getCallbackUrl());
}

// ── GET /api/google-drive/status ──────────────────────────────────────────────
router.get('/status', authJwt, authorizeRole(['super_admin']), async (req, res, next) => {
  try {
    const setting = await SystemSetting.findOne({ where: { key: SETTING_KEY } });
    const d = setting?.data || {};
    const hasDbToken  = Boolean(d.refresh_token_enc);
    const hasEnvToken = Boolean(process.env.GOOGLE_OAUTH_REFRESH_TOKEN);

    if (!hasDbToken && !hasEnvToken) {
      return res.json({ connected: false });
    }
    res.json({
      connected: true,
      email:        d.email        || null,
      connected_at: d.connected_at || null,
      source: hasDbToken ? 'db' : 'env',
    });
  } catch (err) { next(err); }
});

// ── GET /api/google-drive/auth-url ────────────────────────────────────────────
router.get('/auth-url', authJwt, authorizeRole(['super_admin']), async (req, res, next) => {
  try {
    const oauth2Client = getOAuth2Client();
    const state = jwt.sign(
      { purpose: 'drive_oauth', userId: req.user.id },
      process.env.JWT_SECRET,
      { expiresIn: '10m' }
    );
    const url = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      prompt:      'consent',
      scope:       SCOPES,
      state,
    });
    res.json({ url });
  } catch (err) { next(err); }
});

// ── GET /api/google-drive/callback ────────────────────────────────────────────
// Pas de authJwt — appelé par Google après consentement OAuth
router.get('/callback', async (req, res) => {
  const frontendUrl  = (process.env.FRONTEND_URL || 'http://localhost:3001').split(',')[0].trim();
  const settingsBase = `${frontendUrl}/settings?tab=database`;

  try {
    const { code, state, error } = req.query;

    if (error) {
      logger.warn('[GoogleDrive] OAuth refusé par l\'utilisateur :', error);
      return res.redirect(`${settingsBase}&drive_error=${encodeURIComponent(error)}`);
    }
    if (!code || !state) {
      return res.redirect(`${settingsBase}&drive_error=missing_params`);
    }

    // Vérifier le state CSRF
    let decoded;
    try {
      decoded = jwt.verify(state, process.env.JWT_SECRET);
    } catch {
      return res.redirect(`${settingsBase}&drive_error=state_invalid`);
    }
    if (decoded.purpose !== 'drive_oauth') {
      return res.redirect(`${settingsBase}&drive_error=state_invalid`);
    }

    const oauth2Client = getOAuth2Client();
    const { tokens }   = await oauth2Client.getToken(code);

    if (!tokens.refresh_token) {
      // Sans refresh_token Google ne renvoie pas de nouveau token si déjà accordé
      // → forcer un nouveau consentement (prompt:'consent' déjà posé dans auth-url)
      return res.redirect(`${settingsBase}&drive_error=no_refresh_token`);
    }

    // Récupérer l'email du compte Google connecté
    oauth2Client.setCredentials(tokens);
    let email = null;
    try {
      const oauth2Info = google.oauth2({ version: 'v2', auth: oauth2Client });
      const info = await oauth2Info.userinfo.get();
      email = info.data.email || null;
    } catch { /* non-bloquant */ }

    // Chiffrer avec la même clé que TOTP (AES-256-GCM)
    const encryptedToken = encryptTotpSecret(tokens.refresh_token);
    await SystemSetting.upsert({
      key:  SETTING_KEY,
      data: {
        refresh_token_enc: encryptedToken,
        email,
        connected_at:  new Date().toISOString(),
        connected_by:  decoded.userId,
      },
    });

    logger.info('[GoogleDrive] Compte connecté avec succès', { email });
    res.redirect(`${settingsBase}&drive_connected=true`);
  } catch (err) {
    logger.error('[GoogleDrive] Erreur callback OAuth', { error: err.message });
    res.redirect(`${settingsBase}&drive_error=${encodeURIComponent(err.message.slice(0, 120))}`);
  }
});

// ── DELETE /api/google-drive/disconnect ───────────────────────────────────────
router.delete('/disconnect', authJwt, authorizeRole(['super_admin']), async (req, res, next) => {
  try {
    await SystemSetting.destroy({ where: { key: SETTING_KEY } });
    logger.info('[GoogleDrive] Compte déconnecté', { by: req.user.id });
    res.json({ message: 'Google Drive déconnecté.' });
  } catch (err) { next(err); }
});

module.exports = router;
