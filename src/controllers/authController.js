const authService = require('../services/authService');
const { Utilisateur } = require('../models');
const { auditAuth, auditUser } = require('../services/auditHelper');
const emailService = require('../services/emailService');
const bcrypt = require('bcrypt');
const logger = require('../utils/logger');

// ---------------------------
// Register
// ---------------------------
async function register(req, res) {
  try {
    const { entreprise, admin } = await authService.registerEntreprise(req.body);

    await auditUser.created(admin, admin, req);

    res.status(201).json({
      message: 'Inscription entreprise effectuée avec succès',
      entreprise: {
        id: entreprise.id,
        nom: entreprise.nom,
        statut: entreprise.statut,
      },
      admin: {
        id: admin.id,
        prenom: admin.prenom,
        nom: admin.nom,
        email: admin.email,
        role: admin.role,
        statut: admin.statut,
      },
    });
  } catch (err) {
    logger.error('register error', err);
    if (
      err.message.includes('requis')
      || err.message.includes('invalide')
      || err.message.includes('correspondent pas')
      || err.message.includes('existe déjà')
      || err.message.includes('caractère')
    ) {
      return res.status(400).json({ message: err.message });
    }

    return res.status(500).json({ message: 'Erreur serveur' });
  }
}

// ---------------------------
// Login
// ---------------------------
const REFRESH_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'strict',
  maxAge: 7 * 24 * 60 * 60 * 1000,
  path: '/api/auth/refresh',
};

async function login(req, res) {
  try {
    const data = await authService.loginUtilisateur(req.body);

    await auditAuth.loginSuccess(data.utilisateur, req);

    res.cookie('refreshToken', data.refreshToken, REFRESH_COOKIE_OPTIONS);
    const { refreshToken: _rt, ...responseData } = data;
    res.json(responseData);
  } catch (err) {
    const message = err?.message || '';

    // === Audit échec login ===
    if (
      message.includes('Utilisateur non trouvé')
      || message.includes('Mot de passe incorrect')
      || message.includes('tentative(s)')
    ) {
      await auditAuth.loginFailed(req.body.email, req);
      return res.status(401).json({ message });
    }

    if (message.includes('temporairement bloqué')) {
      await auditAuth.loginFailed(req.body.email, req);
      return res.status(423).json({ message });
    }

    if (message.includes('Entreprise inactive') || message.includes('attente') || message.includes('désactivé')) {
      return res.status(403).json({ message });
    }

    logger.error('Login error:', err);
    res.status(500).json({ message: 'Erreur serveur' });
  }
}

// ---------------------------
// Logout
// ---------------------------
async function logout(req, res) {
  try {
    res.clearCookie('refreshToken', { path: '/api/auth/refresh' });
    await auditAuth.logout(req.user, req);
    res.json({ message: 'Déconnexion réussie' });
  } catch (err) {
    res.status(500).json({ message: 'Erreur serveur' });
  }
}

// ---------------------------
// Refresh access token
// ---------------------------
async function refresh(req, res) {
  try {
    const jwt = require('jsonwebtoken');
    const { Utilisateur, Entreprise } = require('../models');

    const token = req.cookies?.refreshToken;
    if (!token) return res.status(401).json({ message: 'Refresh token manquant' });

    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET);
    } catch {
      return res.status(401).json({ message: 'Refresh token invalide ou expiré' });
    }

    if (decoded.type !== 'refresh') {
      return res.status(401).json({ message: 'Token invalide' });
    }

    const user = await Utilisateur.findByPk(decoded.id);
    if (!user || user.statut === 'inactif') {
      return res.status(401).json({ message: 'Utilisateur introuvable ou inactif' });
    }

    const entreprise = await Entreprise.findByPk(user.entreprise_id);
    if (!entreprise || entreprise.statut !== 'active') {
      return res.status(403).json({ message: 'Entreprise inactive' });
    }

    const { sessionTimeout } = await require('../services/authService').getRuntimeSecuritySettings ? { sessionTimeout: 60 } : { sessionTimeout: 60 };
    const newAccessToken = jwt.sign(
      { id: user.id, role: user.role, entreprise_id: user.entreprise_id },
      process.env.JWT_SECRET,
      { expiresIn: '60m' }
    );

    res.json({ token: newAccessToken });
  } catch (err) {
    logger.error('Refresh token error:', err);
    res.status(500).json({ message: 'Erreur serveur' });
  }
}

// ---------------------------
// Forgot password
// ---------------------------
async function forgotPassword(req, res) {
  const genericResponse = { message: 'Si un compte existe, un email a ete envoye' };

  try {
    await authService.forgotPassword(req.body?.email);

    // === Audit demande reset ===
    await auditAuth.passwordResetRequest(req.body?.email, req);
  } catch (_) {
    // Reponse volontairement identique pour eviter la fuite d'information.
  }

  return res.status(200).json(genericResponse);
}

// ---------------------------
// Reset password
// ---------------------------
async function resetPassword(req, res) {
  try {
    const user = await authService.resetPassword(req.body.token, req.body.newPassword);

    try {
      await emailService.sendPasswordResetConfirmation(user.email);
    } catch (mailErr) {
      logger.error('Erreur envoi email confirmation reset password:', mailErr.message);
    }

    // === Audit succès reset ===
    await auditAuth.passwordResetSuccess(user, req);

    res.json({ message: 'Mot de passe réinitialisé avec succès' });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

// ---------------------------
// Change password
// ---------------------------
async function changePassword(req, res) {
  try {
    const { currentPassword, newPassword } = req.body || {};
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ message: 'Utilisateur non authentifié' });

    if (!currentPassword || typeof currentPassword !== 'string' || !currentPassword.trim()) {
      return res.status(400).json({ message: 'Mot de passe actuel requis' });
    }

    if (!newPassword || typeof newPassword !== 'string' || !newPassword.trim()) {
      return res.status(400).json({ message: 'Nouveau mot de passe requis' });
    }

    const user = await Utilisateur.findByPk(userId);
    if (!user) return res.status(404).json({ message: 'Utilisateur introuvable' });

    const isCurrentPasswordValid = await bcrypt.compare(currentPassword, user.password_hash);
    if (!isCurrentPasswordValid) return res.status(400).json({ message: 'Mot de passe actuel incorrect' });

    user.password_hash = await bcrypt.hash(newPassword, 10);
    await user.save();

    try {
      await emailService.sendPasswordResetConfirmation(user.email);
    } catch (mailErr) {
      logger.error('Erreur envoi email confirmation changement password:', mailErr.message);
    }

    // === Audit succès changement mot de passe ===
    await auditAuth.passwordChanged(user, req);

    return res.status(200).json({ message: 'Mot de passe changé avec succès' });

  } catch (err) {
    logger.error('Erreur changement mot de passe:', err);
    return res.status(500).json({ message: 'Erreur serveur', error: err.message });
  }
}

module.exports = {
  register,
  login,
  logout,
  refresh,
  forgotPassword,
  resetPassword,
  changePassword
};