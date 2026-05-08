const { Utilisateur, Entreprise, sequelize } = require('../models');
const logger = require('../utils/logger');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const emailService = require('./emailService');
const systemSettingsService = require('./systemSettingsService');
require('dotenv').config();

const DEFAULT_LEAVE_POLICY = {
  approval_workflow: 'manager_admin',
  overlap_policy: 'block',
  minimum_notice_days: 0,
  max_consecutive_days: 365,
  include_holidays_in_count: false,
  report_autorise: false,
  report_max_jours: 0,
  accrual_by_type: {},
  blocked_days: [],
  service_policies: {},
  max_employees_on_leave: {
    global: 0,
    by_service: {},
  },
};

function hashRefreshToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function getRuntimeSecuritySettings() {
  try {
    const settings = await systemSettingsService.getSettings();
    return {
      maxLoginAttempts: Number(settings?.maxLoginAttempts ?? 5),
      sessionTimeout: Number(settings?.sessionTimeout ?? 60),
      passwordMinLength: Number(settings?.passwordMinLength ?? 8),
      requireSpecialChars: Boolean(settings?.requireSpecialChars ?? true),
    };
  } catch (error) {
    logger.error('Impossible de charger les paramètres système, fallback par défaut:', error.message);
    return {
      maxLoginAttempts: Number(systemSettingsService.DEFAULT_SETTINGS?.maxLoginAttempts ?? 5),
      sessionTimeout: Number(systemSettingsService.DEFAULT_SETTINGS?.sessionTimeout ?? 60),
      passwordMinLength: Number(systemSettingsService.DEFAULT_SETTINGS?.passwordMinLength ?? 8),
      requireSpecialChars: Boolean(systemSettingsService.DEFAULT_SETTINGS?.requireSpecialChars ?? true),
    };
  }
}

// ---------------------------
// Validation de la politique de mot de passe
// ---------------------------
async function validatePasswordPolicy(password) {
  const { passwordMinLength, requireSpecialChars } = await getRuntimeSecuritySettings();
  if (!password || password.length < passwordMinLength) {
    throw new Error(`Le mot de passe doit contenir au moins ${passwordMinLength} caractère(s).`);
  }
  if (requireSpecialChars && !/[!@#$%^&*()_+\-=[\]{};':"\\|,.<>\/?]/.test(password)) {
    throw new Error('Le mot de passe doit contenir au moins un caractère spécial.');
  }
}

// Dummy hash utilisé quand l'utilisateur n'existe pas — maintient un timing constant
// pour éviter l'énumération d'emails par différence de temps de réponse.
const DUMMY_HASH = '$2b$10$CwTycUXWue0Thq9StjUM0uJ8e2Q1rQy4u9n2pV0Xl1yZ9XKp1JfG2';

// ---------------------------
// Login utilisateur
// ---------------------------
async function loginUtilisateur({ email, password, entreprise_id }) {
  const { maxLoginAttempts, sessionTimeout } = await getRuntimeSecuritySettings();

  const whereClause = entreprise_id ? { email, entreprise_id } : { email };
  const user = await Utilisateur.findOne({ where: whereClause });

  // bcrypt.compare s'exécute toujours (DUMMY_HASH si user inexistant) pour garantir
  // un timing identique quel que soit l'email fourni — empêche l'énumération par timing.
  const hashToCompare = user ? user.password_hash : DUMMY_HASH;
  const isMatch = await bcrypt.compare(password, hashToCompare);

  if (!user || !isMatch) {
    // Incrémenter le compteur uniquement si l'utilisateur existe —
    // pas de différence de message ou de comportement observable côté client.
    if (user) {
      const newAttempts = (user.failed_login_attempts || 0) + 1;
      const updates = { failed_login_attempts: newAttempts };
      if (newAttempts >= maxLoginAttempts) {
        updates.locked_until = new Date(Date.now() + 30 * 60 * 1000);
        await user.update(updates);
        emailService.sendAccountLocked(user, newAttempts).catch((e) =>
          logger.error('sendAccountLocked error', { error: e.message })
        );
      } else {
        await user.update(updates);
      }
    }
    throw new Error('Identifiants invalides');
  }

  // Message identique à "mauvais mot de passe" — aucune fuite sur l'état du compte.
  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    throw new Error('Identifiants invalides');
  }

  const entreprise = await Entreprise.findByPk(user.entreprise_id);
  if (!entreprise || entreprise.statut !== 'active') {
    throw new Error('Entreprise inactive ou suspendue.');
  }

  if (user.statut === 'en_attente') throw new Error('Votre compte est en attente de validation.');
  if (user.statut === 'inactif') throw new Error('Votre compte est désactivé. Contactez l\'administrateur.');

  // Réinitialiser le compteur après authentification complète
  await user.update({ failed_login_attempts: 0, locked_until: null, last_login: new Date() });

  // 2FA check — return pending token instead of full session
  if (user.totp_enabled) {
    const pendingToken = jwt.sign(
      { id: user.id, type: '2fa_pending' },
      process.env.JWT_SECRET,
      { expiresIn: '5m' }
    );
    return { requires2fa: true, pending_token: pendingToken };
  }

  const payload = { id: user.id, role: user.role, entreprise_id: user.entreprise_id };
  const token = jwt.sign(payload, process.env.JWT_SECRET, {
    expiresIn: `${sessionTimeout}m`,
  });
  const refreshToken = jwt.sign(
    { id: user.id, type: 'refresh' },
    process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );

  // Store hash of refresh token — enables server-side rotation & replay detection
  await user.update({ refresh_token_hash: hashRefreshToken(refreshToken) });

  return {
    token,
    refreshToken,
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

async function registerEntreprise(payload) {
  const {
    entreprise_nom,
    entreprise_adresse,
    entreprise_telephone,
    entreprise_email,
    admin_prenom,
    admin_nom,
    admin_email,
    admin_password,
    admin_confirm_password,
  } = payload;

  if (!entreprise_nom?.trim()) throw new Error('Le nom de l\'entreprise est requis');
  if (!entreprise_email?.trim()) throw new Error('L\'email de l\'entreprise est requis');
  if (!entreprise_telephone?.trim()) throw new Error('Le téléphone de l\'entreprise est requis');
  if (!admin_prenom?.trim()) throw new Error('Le prénom de l\'administrateur est requis');
  if (!admin_nom?.trim()) throw new Error('Le nom de l\'administrateur est requis');
  if (!admin_email?.trim()) throw new Error('L\'email de l\'administrateur est requis');
  if (!admin_password) throw new Error('Le mot de passe administrateur est requis');
  if (admin_password !== admin_confirm_password) throw new Error('Les mots de passe ne correspondent pas');

  await validatePasswordPolicy(admin_password);

  const emailRegex = /\S+@\S+\.\S+/;
  if (!emailRegex.test(entreprise_email)) throw new Error('Format d\'email entreprise invalide');
  if (!emailRegex.test(admin_email)) throw new Error('Format d\'email administrateur invalide');

  const existingAdmin = await Utilisateur.findOne({ where: { email: admin_email.trim() } });
  if (existingAdmin) {
    throw new Error('Un utilisateur existe déjà avec cet email');
  }

  const passwordHash = await bcrypt.hash(admin_password, 10);

  const result = await sequelize.transaction(async (transaction) => {
    const entreprise = await Entreprise.create({
      nom: entreprise_nom.trim(),
      politique_conges: DEFAULT_LEAVE_POLICY,
      parametres: {
        contact: {
          adresse: entreprise_adresse?.trim() || '',
          telephone: entreprise_telephone.trim(),
          email: entreprise_email.trim().toLowerCase(),
        },
      },
      statut: 'active',
    }, { transaction });

    const admin = await Utilisateur.create({
      entreprise_id: entreprise.id,
      prenom: admin_prenom.trim(),
      nom: admin_nom.trim(),
      email: admin_email.trim().toLowerCase(),
      role: 'admin_entreprise',
      password_hash: passwordHash,
      statut: 'actif',
      service: null,
    }, { transaction });

    return { entreprise, admin };
  });

  try {
    await emailService.sendRegistrationConfirmation(result.entreprise, result.admin);
  } catch (error) {
    logger.error('Erreur email confirmation inscription entreprise:', error.message);
  }

  try {
    await emailService.sendSuperAdminNotification(result.entreprise, result.admin);
  } catch (error) {
    logger.error('Erreur notification inscription entreprise:', error.message);
  }

  return result;
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
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!normalizedEmail) throw new Error('Email requis');

  const user = await Utilisateur.findOne({ where: { email: normalizedEmail } });
  if (!user) throw new Error('Utilisateur non trouvé');

  // Générer token temporaire pour reset et l'envoyer par email
  const resetToken = jwt.sign({ id: user.id, type: 'reset' }, process.env.JWT_SECRET, { expiresIn: '1h' });

  await emailService.sendPasswordReset(user.email, resetToken);
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

  return user;
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
    logger.error('Erreur changement mot de passe:', err.message);
    throw err;
  }
}

// ---------------------------
// Set password (invitation link — première connexion)
// ---------------------------
async function setPassword(token, password, confirmPassword) {
  if (password !== confirmPassword) throw new Error('Les mots de passe ne correspondent pas');

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    throw new Error('Lien invalide ou expiré');
  }

  if (decoded.type !== 'set_password') throw new Error('Lien invalide');

  const user = await Utilisateur.findByPk(decoded.id);
  if (!user) throw new Error('Utilisateur introuvable');

  if (!user.invite_token_hash) throw new Error('Lien déjà utilisé');
  const { createHash } = require('crypto');
  const receivedHash = createHash('sha256').update(token).digest('hex');
  if (user.invite_token_hash !== receivedHash) throw new Error('Lien invalide');

  await validatePasswordPolicy(password);

  user.password_hash = await bcrypt.hash(password, 10);
  if (user.statut !== 'inactif') user.statut = 'actif';
  await user.save();
  await user.update({ invite_token_hash: null });

  emailService.sendWelcomeAfterActivation(user).catch((e) =>
    logger.error('sendWelcomeAfterActivation error', { error: e.message })
  );

  return user;
}

function generateAccessToken(user, expiresInMinutes = 60) {
  return jwt.sign(
    { id: user.id, role: user.role, entreprise_id: user.entreprise_id },
    process.env.JWT_SECRET,
    { expiresIn: `${expiresInMinutes}m` }
  );
}

module.exports = {
  loginUtilisateur,
  registerEntreprise,
  logoutUtilisateur,
  forgotPassword,
  resetPassword,
  changePassword,
  setPassword,
  validatePasswordPolicy,
  generateAccessToken,
  hashRefreshToken,
};