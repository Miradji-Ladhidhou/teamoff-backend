'use strict';
/**
 * settingsCrypto.test.js
 *
 * Couvre :
 *  - Chiffrement / déchiffrement AES-256-GCM des secrets settings (unit)
 *  - Vérification que updateSettings stocke les secrets chiffrés en DB
 *  - Vérification que getSettings retourne les secrets déchiffrés (plaintext)
 *  - Compatibilité legacy plaintext (rétrocompatibilité migration)
 */

const { SystemSetting } = require('../src/models');
const systemSettingsService = require('../src/services/systemSettingsService');
const { seed } = require('./helpers/seed');

// ---------------------------------------------------------------------------
// Unit — settingsCrypto
// ---------------------------------------------------------------------------
describe('settingsCrypto — chiffrement AES-256-GCM', () => {
  const { encryptSecret, decryptSecret, isEncrypted } = require('../src/utils/settingsCrypto');

  const PLAINTEXT = 'SuperSecretSMTPPass!123';

  it('encryptSecret retourne un format iv:tag:ciphertext', () => {
    const encrypted = encryptSecret(PLAINTEXT);
    const parts = encrypted.split(':');
    expect(parts).toHaveLength(3);
    expect(parts[0]).toHaveLength(24); // IV 12 octets → 24 hex
    expect(parts[1]).toHaveLength(32); // authTag 16 octets → 32 hex
    expect(parts[2].length).toBeGreaterThan(0);
  });

  it('encryptSecret produit un ciphertext différent à chaque appel (IV aléatoire)', () => {
    const a = encryptSecret(PLAINTEXT);
    const b = encryptSecret(PLAINTEXT);
    expect(a).not.toBe(b);
  });

  it('decryptSecret restitue le plaintext original', () => {
    const encrypted = encryptSecret(PLAINTEXT);
    expect(decryptSecret(encrypted)).toBe(PLAINTEXT);
  });

  it('decryptSecret passe en clair les valeurs legacy (pas de ":")', () => {
    expect(decryptSecret('legacypassword')).toBe('legacypassword');
  });

  it('decryptSecret retourne la valeur telle quelle si nulle ou vide', () => {
    expect(decryptSecret(null)).toBeNull();
    expect(decryptSecret('')).toBe('');
    expect(decryptSecret(undefined)).toBeUndefined();
  });

  it('isEncrypted distingue chiffré et plaintext', () => {
    expect(isEncrypted(encryptSecret(PLAINTEXT))).toBe(true);
    expect(isEncrypted('legacyplaintext')).toBe(false);
    expect(isEncrypted(null)).toBe(false);
    expect(isEncrypted('')).toBe(false);
  });

  it('encryptSecret lance une erreur si SETTINGS_ENCRYPTION_KEY est absente', () => {
    const saved = process.env.SETTINGS_ENCRYPTION_KEY;
    delete process.env.SETTINGS_ENCRYPTION_KEY;
    expect(() => encryptSecret(PLAINTEXT)).toThrow('SETTINGS_ENCRYPTION_KEY');
    process.env.SETTINGS_ENCRYPTION_KEY = saved;
  });

  it('encryptSecret lance une erreur si SETTINGS_ENCRYPTION_KEY est malformée', () => {
    const saved = process.env.SETTINGS_ENCRYPTION_KEY;
    process.env.SETTINGS_ENCRYPTION_KEY = 'trop_court';
    expect(() => encryptSecret(PLAINTEXT)).toThrow('64 caractères hexadécimaux');
    process.env.SETTINGS_ENCRYPTION_KEY = saved;
  });

  it('intégrité GCM : ciphertext altéré → exception', () => {
    const encrypted = encryptSecret(PLAINTEXT);
    const parts = encrypted.split(':');
    parts[2] = parts[2].slice(0, -2) + 'ff';
    expect(() => decryptSecret(parts.join(':'))).toThrow();
  });

  it('encryptSecret retourne la valeur telle quelle si vide/nulle', () => {
    expect(encryptSecret('')).toBeFalsy();
    expect(encryptSecret(null)).toBeNull();
    expect(encryptSecret(undefined)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Intégration — chiffrement en DB via systemSettingsService
// ---------------------------------------------------------------------------
describe('systemSettingsService — secrets chiffrés en DB', () => {
  const { isEncrypted } = require('../src/utils/settingsCrypto');

  let ctx;
  const TEST_PASS    = 'MonMotDePasseSMTP_' + Date.now();
  const TEST_WEBHOOK = 'https://hooks.slack.com/test_' + Date.now();

  beforeAll(async () => {
    ctx = await seed();
  });

  afterAll(async () => {
    await systemSettingsService.updateSettings({ smtpPassword: '', slackWebhook: '' });
    await ctx.cleanup();
  });

  it('updateSettings chiffre smtpPassword avant écriture en DB', async () => {
    await systemSettingsService.updateSettings({ smtpPassword: TEST_PASS });

    const row = await SystemSetting.findOne({ where: { key: 'global' } });
    const stored = row.data?.smtpPassword;

    expect(stored).toBeTruthy();
    expect(isEncrypted(stored)).toBe(true);
    // Le plaintext ne doit pas apparaître en DB
    expect(stored).not.toBe(TEST_PASS);
    expect(stored).not.toContain(TEST_PASS);
  });

  it('updateSettings chiffre slackWebhook avant écriture en DB', async () => {
    await systemSettingsService.updateSettings({ slackWebhook: TEST_WEBHOOK });

    const row = await SystemSetting.findOne({ where: { key: 'global' } });
    const stored = row.data?.slackWebhook;

    expect(stored).toBeTruthy();
    expect(isEncrypted(stored)).toBe(true);
    expect(stored).not.toBe(TEST_WEBHOOK);
  });

  it('getSettings retourne smtpPassword déchiffré (plaintext)', async () => {
    await systemSettingsService.updateSettings({ smtpPassword: TEST_PASS });
    const settings = await systemSettingsService.getSettings();
    expect(settings.smtpPassword).toBe(TEST_PASS);
  });

  it('getSettings retourne slackWebhook déchiffré (plaintext)', async () => {
    await systemSettingsService.updateSettings({ slackWebhook: TEST_WEBHOOK });
    const settings = await systemSettingsService.getSettings();
    expect(settings.slackWebhook).toBe(TEST_WEBHOOK);
  });

  it('updateSettings ne double-chiffre pas un secret déjà chiffré', async () => {
    await systemSettingsService.updateSettings({ smtpPassword: TEST_PASS });

    // Un second updateSettings sans toucher smtpPassword ne doit pas re-chiffrer
    await systemSettingsService.updateSettings({ smtpHost: 'smtp.example.com' });

    const settings = await systemSettingsService.getSettings();
    // Le mot de passe doit toujours être lisible correctement après double passage
    expect(settings.smtpPassword).toBe(TEST_PASS);
  });

  it('les champs non-secrets (smtpHost) restent en clair en DB', async () => {
    await systemSettingsService.updateSettings({ smtpHost: 'smtp.monserveur.com' });

    const row = await SystemSetting.findOne({ where: { key: 'global' } });
    // smtpHost n'est pas dans SECRET_FIELDS — doit être en clair
    expect(row.data?.smtpHost).toBe('smtp.monserveur.com');
    expect(isEncrypted(row.data?.smtpHost)).toBe(false);
  });
});
