const authService = require('../services/authService');
const { auditAuth } = require('../services/auditHelper');

// ---------------------------
// Login
// ---------------------------
async function login(req, res) {
  try {
    const data = await authService.loginUtilisateur(req.body);

    // === Audit succès ===
    await auditAuth.loginSuccess(data.user, req);

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

module.exports = {
  login,
  logout,
  forgotPassword,
  resetPassword
};