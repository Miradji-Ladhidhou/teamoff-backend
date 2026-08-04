const { SystemSetting } = require('../models');
const { encryptSecret, decryptSecret, isEncrypted } = require('../utils/settingsCrypto');

const SETTINGS_KEY = 'global';

// Champs contenant des secrets chiffrés au repos (RGPD / sécurité backup)
const SECRET_FIELDS = ['smtpPassword', 'slackWebhook'];

function encryptSecretFields(settings) {
  const out = { ...settings };
  for (const field of SECRET_FIELDS) {
    if (out[field] && !isEncrypted(out[field])) {
      out[field] = encryptSecret(out[field]);
    }
  }
  return out;
}

function decryptSecretFields(settings) {
  const out = { ...settings };
  for (const field of SECRET_FIELDS) {
    if (out[field] && isEncrypted(out[field])) {
      out[field] = decryptSecret(out[field]);
    }
  }
  return out;
}

const DEFAULT_SETTINGS = {
  appName: 'TeamOff',
  appVersion: '1.0.0',
  maintenanceMode: false,
  maintenanceMessage: 'Application en maintenance. Veuillez reessayer plus tard.',
  maxFileSize: 10,
  smtpHost: '',
  smtpPort: 587,
  smtpUser: '',
  smtpPassword: '',
  emailFrom: '',
  sessionTimeout: 15,
  maxLoginAttempts: 5,
  passwordMinLength: 8,
  requireSpecialChars: true,
  emailNotifications: true,
  pushNotifications: true,
  slackWebhook: '',
  dbBackupFrequency: 'daily',
  dbRetentionDays: 30,
  lastBackupAt: null,
};

let maintenanceCache = {
  value: false,
  message: DEFAULT_SETTINGS.maintenanceMessage,
  fetchedAt: 0,
};

const MAINTENANCE_CACHE_TTL_MS = 10 * 1000;

function sanitizeSettings(input = {}) {
  return {
    ...DEFAULT_SETTINGS,
    ...input,
    maintenanceMode: Boolean(input.maintenanceMode ?? DEFAULT_SETTINGS.maintenanceMode),
    maintenanceMessage: String(input.maintenanceMessage ?? DEFAULT_SETTINGS.maintenanceMessage),
    maxFileSize: Number(input.maxFileSize ?? DEFAULT_SETTINGS.maxFileSize),
    smtpPort: Number(input.smtpPort ?? DEFAULT_SETTINGS.smtpPort),
    sessionTimeout: Number(input.sessionTimeout ?? DEFAULT_SETTINGS.sessionTimeout),
    maxLoginAttempts: Number(input.maxLoginAttempts ?? DEFAULT_SETTINGS.maxLoginAttempts),
    passwordMinLength: Number(input.passwordMinLength ?? DEFAULT_SETTINGS.passwordMinLength),
    requireSpecialChars: Boolean(input.requireSpecialChars ?? DEFAULT_SETTINGS.requireSpecialChars),
    emailNotifications: Boolean(input.emailNotifications ?? DEFAULT_SETTINGS.emailNotifications),
    pushNotifications: Boolean(input.pushNotifications ?? DEFAULT_SETTINGS.pushNotifications),
    dbRetentionDays: Number(input.dbRetentionDays ?? DEFAULT_SETTINGS.dbRetentionDays),
  };
}

async function getOrCreateSettingsRow() {
  let row = await SystemSetting.findOne({ where: { key: SETTINGS_KEY } });

  if (!row) {
    row = await SystemSetting.create({
      key: SETTINGS_KEY,
      data: DEFAULT_SETTINGS,
    });
  }

  return row;
}

async function getSettings() {
  const row = await getOrCreateSettingsRow();
  // Déchiffrer les secrets avant de retourner (emailService / notificationService reçoivent du plaintext)
  return {
    ...sanitizeSettings(decryptSecretFields(row.data || {})),
    updatedAt: row.updatedAt,
  };
}

async function updateSettings(partial, updatedBy = null) {
  const row = await getOrCreateSettingsRow();
  // Déchiffrer le stocké avant merge pour éviter double-chiffrement
  const current = decryptSecretFields(row.data || {});
  const merged  = sanitizeSettings({ ...current, ...partial });

  // Chiffrer les secrets avant persistance
  row.data = encryptSecretFields(merged);
  row.updated_by = updatedBy;
  await row.save();

  maintenanceCache = {
    value: Boolean(merged.maintenanceMode),
    message: merged.maintenanceMessage,
    fetchedAt: Date.now(),
  };

  // Retourner en plaintext (les callers s'attendent à des valeurs lisibles)
  return { ...merged, updatedAt: row.updatedAt };
}

async function updateSection(section, values, updatedBy = null) {
  const sectionMap = {
    general: ['appName', 'maintenanceMode', 'maintenanceMessage', 'maxFileSize'],
    security: ['sessionTimeout', 'maxLoginAttempts', 'passwordMinLength', 'requireSpecialChars'],
    email: ['smtpHost', 'smtpPort', 'smtpUser', 'smtpPassword', 'emailFrom'],
    notifications: ['emailNotifications', 'pushNotifications', 'slackWebhook'],
    database: ['dbBackupFrequency', 'dbRetentionDays'],
  };

  const allowedFields = sectionMap[section];
  if (!allowedFields) {
    const error = new Error('Section de paramètres invalide');
    error.statusCode = 400;
    throw error;
  }

  const partial = {};
  allowedFields.forEach((field) => {
    if (Object.prototype.hasOwnProperty.call(values, field)) {
      partial[field] = values[field];
    }
  });

  return updateSettings(partial, updatedBy);
}

async function isMaintenanceEnabled() {
  const now = Date.now();

  if (now - maintenanceCache.fetchedAt < MAINTENANCE_CACHE_TTL_MS) {
    return maintenanceCache.value;
  }

  const settings = await getSettings();
  maintenanceCache = {
    value: Boolean(settings.maintenanceMode),
    message: settings.maintenanceMessage || DEFAULT_SETTINGS.maintenanceMessage,
    fetchedAt: now,
  };

  return maintenanceCache.value;
}

async function getMaintenanceStatus() {
  const now = Date.now();

  if (now - maintenanceCache.fetchedAt < MAINTENANCE_CACHE_TTL_MS) {
    return {
      enabled: maintenanceCache.value,
      message: maintenanceCache.message || DEFAULT_SETTINGS.maintenanceMessage,
    };
  }

  const settings = await getSettings();
  maintenanceCache = {
    value: Boolean(settings.maintenanceMode),
    message: settings.maintenanceMessage || DEFAULT_SETTINGS.maintenanceMessage,
    fetchedAt: now,
  };

  return {
    enabled: maintenanceCache.value,
    message: maintenanceCache.message,
  };
}

module.exports = {
  DEFAULT_SETTINGS,
  getSettings,
  updateSettings,
  updateSection,
  isMaintenanceEnabled,
  getMaintenanceStatus,
};
