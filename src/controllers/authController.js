const authService = require('../services/authService');
const { auditAuth } = require('../services/auditHelper');
const { Utilisateur } = require('../models');
const bcrypt = require('bcrypt');

// ---------------------------
// Login
// ---------------------------
async function login(req, res) {
  try {
    const data = await authService.loginUtilisateur(req.body);

    // === Audit succès ===
    // authService renvoie la clé "utilisateur" (pas "user")
    await auditAuth.loginSuccess(data.utilisateur, req);

    res.json(data);
  } catch (err) {
    // === Audit échec login ===
    if (err.message.includes('Utilisateur non trouvé') || err.message.includes('Mot de passe incorrect')) {
      await auditAuth.loginFailed(req.body.email, req);
      return res.status(401).json({ message: err.message });
    }

    if (err.message.includes('Entreprise inactive') || err.message.includes('attente') || err.message.includes('désactivé')) {
      return res.status(403).json({ message: err.message });
    }

    console.error('Login error:', err);
    res.status(500).json({ message: 'Erreur serveur' });
  }
}

// ---------------------------
// Logout
// ---------------------------
async function logout(req, res) {
  try {
    await authService.logoutUtilisateur(); // éventuellement passer le token

    // === Audit ===
    await auditAuth.logout(req.user, req);

    res.json({ message: 'Déconnexion réussie' });
  } catch (err) {
    res.status(500).json({ message: 'Erreur serveur' });
  }
}

// ---------------------------
// Forgot password
// ---------------------------
async function forgotPassword(req, res) {
  try {
    const token = await authService.forgotPassword(req.body.email);

    // === Audit demande reset ===
    await auditAuth.passwordResetRequest(req.body.email, req);

    res.json({ message: 'Email de réinitialisation envoyé', resetToken: token });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

// ---------------------------
// Reset password
// ---------------------------
async function resetPassword(req, res) {
  try {
    const user = await authService.resetPassword(req.body.token, req.body.newPassword);

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
    console.log('req.user:', req.user);
    console.log('req.body:', req.body);

    const { currentPassword, newPassword } = req.body;
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ message: 'Utilisateur non authentifié' });

    const user = await Utilisateur.findByPk(userId);
    if (!user) return res.status(404).json({ message: 'Utilisateur introuvable' });

    const isMatch = await bcrypt.compare(currentPassword, user.password_hash);
    if (!isMatch) return res.status(400).json({ message: 'Mot de passe actuel incorrect' });

    user.password_hash = await bcrypt.hash(newPassword, 10);
    await user.save();

    // === Audit succès changement mot de passe ===
    await auditAuth.passwordChangeSuccess(user, req);

    return res.status(200).json({ message: 'Mot de passe changé avec succès' });

  } catch (err) {
    console.error('Erreur changement mot de passe:', err);
    return res.status(500).json({ message: 'Erreur serveur', error: err.message });
  }
}

module.exports = {
  login,
  logout,
  forgotPassword,
  resetPassword,
  changePassword
};