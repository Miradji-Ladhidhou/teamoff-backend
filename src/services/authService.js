const { Utilisateur, Entreprise } = require('../models');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const systemSettingsService = require('./systemSettingsService');
require('dotenv').config();

// ---------------------------
// Validation de la politique de mot de passe
// ---------------------------
async function validatePasswordPolicy(password) {
  const { passwordMinLength, requireSpecialChars } = await systemSettingsService.getSettings();
  if (!password || password.length < passwordMinLength) {
    throw new Error(`Le mot de passe doit contenir au moins ${passwordMinLength} caractère(s).`);
  }
  if (requireSpecialChars && !/[!@#$%^&*()_+\-=[\]{};':"\\|,.<>\/?]/.test(password)) {
    throw new Error('Le mot de passe doit contenir au moins un caractère spécial.');
  }
}

// ---------------------------
// Login utilisateur
// ---------------------------
async function loginUtilisateur({ email, password, entreprise_id }) {
  const { maxLoginAttempts, sessionTimeout } = await systemSettingsService.getSettings();

  const whereClause = entreprise_id ? { email, entreprise_id } : { email };
  const user = await Utilisateur.findOne({ where: whereClause });
  if (!user) throw new Error('Utilisateur non trouvé');

  // Vérifier si le compte est temporairement bloqué
  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    const remainingMs = new Date(user.locked_until) - new Date();
    const remainingMin = Math.ceil(remainingMs / 1000 / 60);
    throw new Error(`Compte temporairement bloqué suite à trop de tentatives. Réessayez dans ${remainingMin} minute(s).`);
  }

  const entreprise = await Entreprise.findByPk(user.entreprise_id);
  if (!entreprise || entreprise.statut !== 'active') {
    throw new Error('Entreprise inactive ou suspendue.');
  }

  if (user.statut === 'en_attente') throw new Error('Votre compte est en attente de validation.');
  if (user.statut === 'inactif') throw new Error('Votre compte est désactivé. Contactez l\'administrateur.');

  const isMatch = await bcrypt.compare(password, user.password_hash);
  if (!isMatch) {
    const newAttempts = (user.failed_login_attempts || 0) + 1;
    const updates = { failed_login_attempts: newAttempts };
    if (newAttempts >= maxLoginAttempts) {
      // Bloquer le compte pendant 30 minutes
      updates.locked_until = new Date(Date.now() + 30 * 60 * 1000);
    }
    await user.update(updates);
    const remaining = maxLoginAttempts - newAttempts;
    if (remaining > 0) {
      throw new Error(`Mot de passe incorrect. Il vous reste ${remaining} tentative(s) avant blocage temporaire.`);
    }
    throw new Error('Compte temporairement bloqué suite à trop de tentatives. Réessayez dans 30 minute(s).');
  }

  // Réinitialiser le compteur après succès
  await user.update({ failed_login_attempts: 0, locked_until: null });

  const payload = { id: user.id, role: user.role, entreprise_id: user.entreprise_id };
  const token = jwt.sign(payload, process.env.JWT_SECRET, {
    expiresIn: `${sessionTimeout}m`,
  });

  return {
    token,
    utilisateur: {
      id: user.id,
      prenom: user.prenom,
      nom: user.nom,
      email: user.email,
      role: user.role,
      entreprise_id: user.entreprise_id,
      entreprise_nom: entreprise.nom
    }
  };
}

// ---------------------------
// Logout utilisateur
// ---------------------------
// Ici simple placeholder, tu peux gérer blacklist JWT si nécessaire
function logoutUtilisateur(token) {
  return true;
}

// ---------------------------
// Forgot password
// ---------------------------
async function forgotPassword(email) {
  const user = await Utilisateur.findOne({ where: { email } });
  if (!user) throw new Error('Utilisateur non trouvé');

  // Générer token temporaire pour reset (à sauvegarder ou envoyer par email)
  const resetToken = jwt.sign({ id: user.id }, process.env.JWT_SECRET, { expiresIn: '1h' });

  // TEMP: afficher le token pour tests
  console.log("RESET TOKEN:", resetToken);

  // TODO: envoyer email via service mail avec resetToken
  return resetToken;
}

// ---------------------------
// Reset password
// ---------------------------
async function resetPassword(token, newPassword) {
  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    throw new Error('Token invalide ou expiré');
  }

  const user = await Utilisateur.findByPk(decoded.id);
  if (!user) throw new Error('Utilisateur introuvable');

  await validatePasswordPolicy(newPassword);

  const hashed = await bcrypt.hash(newPassword, 10);
  user.password_hash = hashed;
  await user.save();

  return true;
}

// ---------------------------
// Modifier mot de passe (pour utilisateur connecté)
// ---------------------------
async function changePassword(userId, currentPassword, newPassword) {
  try {
    const user = await Utilisateur.findByPk(userId);
    if (!user) throw new Error('Utilisateur introuvable');

    const isMatch = await bcrypt.compare(currentPassword, user.password_hash);
    if (!isMatch) throw new Error('Mot de passe actuel incorrect');

    await validatePasswordPolicy(newPassword);

    const hashed = await bcrypt.hash(newPassword, 10);
    user.password_hash = hashed;
    await user.save();

    return true;
  } catch (err) {
    console.error('Erreur changement mot de passe:', err.message);
    throw err;
  }
}

module.exports = {
  loginUtilisateur,
  logoutUtilisateur,
  forgotPassword,
  resetPassword,
  changePassword,
  validatePasswordPolicy
};