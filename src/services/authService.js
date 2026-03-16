const { Utilisateur, Entreprise } = require('../models');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
require('dotenv').config();

// ---------------------------
// Login utilisateur
// ---------------------------
async function loginUtilisateur({ email, password, entreprise_id }) {
  const whereClause = entreprise_id ? { email, entreprise_id } : { email };
  const user = await Utilisateur.findOne({ where: whereClause });
  if (!user) throw new Error('Utilisateur non trouvé');

  const entreprise = await Entreprise.findByPk(user.entreprise_id);
  if (!entreprise || entreprise.statut !== 'active') {
    throw new Error('Entreprise inactive ou suspendue.');
  }

  if (user.statut === 'en_attente') throw new Error('Votre compte est en attente de validation.');
  if (user.statut === 'inactif') throw new Error('Votre compte est désactivé. Contactez l\'administrateur.');

  const isMatch = await bcrypt.compare(password, user.password_hash);
  if (!isMatch) throw new Error('Mot de passe incorrect');

  const payload = { id: user.id, role: user.role, entreprise_id: user.entreprise_id };
  const token = jwt.sign(payload, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '1d',
  });

  return {
    token,
    utilisateur: {
      id: user.id,
      nom: user.nom,
      email: user.email,
      role: user.role,
      entreprise_id: user.entreprise_id
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
  changePassword
};