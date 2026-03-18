const { Utilisateur, Entreprise, sequelize } = require('../models');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const systemSettingsService = require('./systemSettingsService');
const emailService = require('./emailService');
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
    console.error('Impossible de charger les paramètres système, fallback par défaut:', error.message);
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

// ---------------------------
// Login utilisateur
// ---------------------------
async function loginUtilisateur({ email, password, entreprise_id }) {
  const { maxLoginAttempts, sessionTimeout } = await getRuntimeSecuritySettings();

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
    console.error('Erreur email confirmation inscription entreprise:', error.message);
  }

  try {
    await emailService.sendSuperAdminNotification(result.entreprise, result.admin);
  } catch (error) {
    console.error('Erreur notification inscription entreprise:', error.message);
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
  const resetToken = jwt.sign({ id: user.id }, process.env.JWT_SECRET, { expiresIn: '1h' });

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
  registerEntreprise,
  logoutUtilisateur,
  forgotPassword,
  resetPassword,
  changePassword,
  validatePasswordPolicy
};