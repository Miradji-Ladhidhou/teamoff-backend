const authService = require('../services/authService');
const { Utilisateur, Entreprise } = require('../models');
const { auditAuth, auditUser } = require('../services/auditHelper');
const emailService = require('../services/emailService');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const logger = require('../utils/logger');

// ---------------------------
// Register
// ---------------------------
async function register(req, res, next) {
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

    return next(err);
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

async function login(req, res, next) {
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
      message.includes('Identifiants invalides')
      || message.includes('Utilisateur non trouvé')
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

    next(err);
  }
}

// ---------------------------
// Logout
// ---------------------------
async function logout(req, res, next) {
  try {
    // Invalidate the refresh token server-side (decode only — no verify needed)
    const cookieToken = req.cookies?.refreshToken;
    if (cookieToken) {
      try {
        const decoded = jwt.decode(cookieToken);
        if (decoded?.id) {
          await Utilisateur.update({ refresh_token_hash: null }, { where: { id: decoded.id } });
        }
      } catch {}
    }
    res.clearCookie('refreshToken', { path: '/api/auth/refresh' });
    await auditAuth.logout(req.user, req);
    res.json({ message: 'Déconnexion réussie' });
  } catch (err) {
    next(err);
  }
}

// ---------------------------
// Refresh access token (with rotation)
// ---------------------------
async function refresh(req, res, next) {
  try {
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

    // 4. Charger l'utilisateur
    const user = await Utilisateur.findByPk(decoded.id);
    if (!user || user.statut === 'inactif') {
      return res.status(401).json({ message: 'Utilisateur introuvable ou inactif' });
    }

    // 5. Vérifier l'entreprise AVANT la rotation — si inactive après rotation,
    //    l'ancien token serait consommé mais l'accès refusé → lockout involontaire.
    const entreprise = await Entreprise.findByPk(user.entreprise_id);
    if (!entreprise || entreprise.statut !== 'active') {
      return res.status(403).json({ message: 'Entreprise inactive' });
    }

    // 6. UPDATE atomique — rotation du refresh token.
    //    WHERE sur refresh_token_hash : une seule requête concurrente peut réussir.
    const receivedHash = authService.hashRefreshToken(token);
    const newRefreshToken = jwt.sign(
      { id: user.id, type: 'refresh' },
      process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );
    const [rotated] = await Utilisateur.update(
      { refresh_token_hash: authService.hashRefreshToken(newRefreshToken) },
      { where: { id: user.id, refresh_token_hash: receivedHash } }
    );

    if (rotated === 0) {
      // Token déjà consommé (replay) — invalider toutes les sessions
      await Utilisateur.update({ refresh_token_hash: null }, { where: { id: user.id } });
      return res.status(401).json({ message: 'Refresh token invalide ou déjà utilisé' });
    }

    // 7. Répondre avec le nouveau couple access + refresh token
    res.cookie('refreshToken', newRefreshToken, REFRESH_COOKIE_OPTIONS);
    const newAccessToken = authService.generateAccessToken(user, 60);
    res.json({ token: newAccessToken });
  } catch (err) {
    next(err);
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
async function changePassword(req, res, next) {
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
    return next(err);
  }
}

// ---------------------------
// Set password (invitation)
// ---------------------------
async function setPassword(req, res) {
  try {
    const { token, password, confirmPassword } = req.body;
    const user = await authService.setPassword(token, password, confirmPassword);

    try {
      await emailService.sendPasswordResetConfirmation(user.email);
    } catch (mailErr) {
      logger.error('setPassword: erreur email confirmation', { error: mailErr.message });
    }

    await auditAuth.passwordResetSuccess(user, req);

    res.json({ message: 'Mot de passe défini avec succès. Vous pouvez vous connecter.' });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

module.exports = {
  register,
  login,
  logout,
  refresh,
  forgotPassword,
  resetPassword,
  changePassword,
  setPassword,
};