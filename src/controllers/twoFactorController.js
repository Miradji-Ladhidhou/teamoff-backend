const speakeasy = require('speakeasy');
const QRCode = require('qrcode');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { Utilisateur, Entreprise } = require('../models');
const authService = require('../services/authService');
const logger = require('../utils/logger');

async function setup2FA(req, res) {
  try {
    const user = await Utilisateur.findByPk(req.user.id);
    if (!user) return res.status(404).json({ message: 'Utilisateur introuvable' });

    const secret = speakeasy.generateSecret({
      name: `TeamOff (${user.email})`,
      issuer: 'TeamOff',
      length: 20,
    });

    // Store secret temporarily (not yet enabled)
    await user.update({ totp_secret: secret.base32 });

    const qrCodeDataUrl = await QRCode.toDataURL(secret.otpauth_url);

    res.json({ secret: secret.base32, qrCode: qrCodeDataUrl });
  } catch (err) {
    logger.error('setup2FA error', { error: err.message });
    res.status(500).json({ message: 'Erreur serveur' });
  }
}

async function enable2FA(req, res) {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ message: 'Code requis' });

    const user = await Utilisateur.findByPk(req.user.id);
    if (!user || !user.totp_secret) {
      return res.status(400).json({ message: 'Configurez d\'abord le 2FA' });
    }

    const valid = speakeasy.totp.verify({
      secret: user.totp_secret,
      encoding: 'base32',
      token: String(code).replace(/\s/g, ''),
      window: 1,
    });

    if (!valid) return res.status(400).json({ message: 'Code invalide' });

    await user.update({ totp_enabled: true });
    res.json({ message: '2FA activé avec succès' });
  } catch (err) {
    logger.error('enable2FA error', { error: err.message });
    res.status(500).json({ message: 'Erreur serveur' });
  }
}

async function disable2FA(req, res) {
  try {
    const { password } = req.body;
    if (!password) return res.status(400).json({ message: 'Mot de passe requis' });

    const user = await Utilisateur.findByPk(req.user.id);
    if (!user) return res.status(404).json({ message: 'Utilisateur introuvable' });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(400).json({ message: 'Mot de passe incorrect' });

    await user.update({ totp_secret: null, totp_enabled: false });
    res.json({ message: '2FA désactivé' });
  } catch (err) {
    logger.error('disable2FA error', { error: err.message });
    res.status(500).json({ message: 'Erreur serveur' });
  }
}

async function verify2FA(req, res) {
  try {
    const { pending_token, code } = req.body;
    if (!pending_token || !code) return res.status(400).json({ message: 'Token et code requis' });

    let decoded;
    try {
      decoded = jwt.verify(pending_token, process.env.JWT_SECRET);
    } catch {
      return res.status(401).json({ message: 'Token invalide ou expiré' });
    }

    if (decoded.type !== '2fa_pending') return res.status(401).json({ message: 'Token invalide' });

    const user = await Utilisateur.findByPk(decoded.id);
    if (!user || !user.totp_enabled || !user.totp_secret) {
      return res.status(400).json({ message: '2FA non configuré' });
    }

    const valid = speakeasy.totp.verify({
      secret: user.totp_secret,
      encoding: 'base32',
      token: String(code).replace(/\s/g, ''),
      window: 1,
    });

    if (!valid) return res.status(400).json({ message: 'Code invalide' });

    const accessToken = authService.generateAccessToken(user);
    const refreshToken = jwt.sign(
      { id: user.id, type: 'refresh' },
      process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );
    await user.update({
      refresh_token_hash: authService.hashRefreshToken(refreshToken),
      last_login: new Date(),
    });

    const entreprise = await Entreprise.findByPk(user.entreprise_id);

    const REFRESH_COOKIE_OPTIONS = {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 7 * 24 * 60 * 60 * 1000,
      path: '/api/auth/refresh',
    };
    res.cookie('refreshToken', refreshToken, REFRESH_COOKIE_OPTIONS);

    res.json({
      token: accessToken,
      utilisateur: {
        id: user.id, prenom: user.prenom, nom: user.nom,
        email: user.email, role: user.role,
        entreprise_id: user.entreprise_id,
        entreprise_nom: entreprise?.nom,
      },
    });
  } catch (err) {
    logger.error('verify2FA error', { error: err.message });
    res.status(500).json({ message: 'Erreur serveur' });
  }
}

module.exports = { setup2FA, enable2FA, disable2FA, verify2FA };
