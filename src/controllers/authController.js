const authService = require('../services/authService');

// ---------------------------
// Login
// ---------------------------
async function login(req, res) {
  try {
    const data = await authService.loginUtilisateur(req.body);
    res.json(data);
  } catch (err) {
    if (err.message.includes('Utilisateur non trouvé') || err.message.includes('Mot de passe incorrect')) {
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
    authService.logoutUtilisateur(); // éventuellement passer le token
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
    res.json({ message: 'Email de réinitialisation envoyé', resetToken: token }); // resetToken pour dev/test
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

// ---------------------------
// Reset password
// ---------------------------
async function resetPassword(req, res) {
  try {
    await authService.resetPassword(req.body.token, req.body.newPassword);
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