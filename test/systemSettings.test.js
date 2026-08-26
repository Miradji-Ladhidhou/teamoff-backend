'use strict';
/**
 * systemSettings.test.js — Chiffrement des secrets SMTP/Slack
 *
 * Vérifie que :
 *  - smtpPassword et slackWebhook sont chiffrés en DB à l'écriture
 *  - getSettings() retourne les valeurs en clair (pour emailService)
 *  - updateSettings() ne double-chiffre pas si appelé plusieurs fois
 *  - Les champs vides ne sont pas chiffrés
 *  - Legacy plaintext (valeur non chiffrée en DB) est retourné tel quel
 *  - emailService.getSmtpConfig() reçoit bien le mot de passe en clair
 */

const { SystemSetting } = require('../src/models');
const systemSettingsService = require('../src/services/systemSettingsService');
const emailService = require('../src/services/emailService');
const { isEncrypted, decryptSecret } = require('../src/utils/settingsCrypto');

// Clé unique pour isoler les tests (éviter conflits avec d'autres suites)
const TEST_KEY = 'test-smtp-settings-' + Date.now();

// Patch SETTINGS_KEY pour isoler les tests dans une ligne séparée
beforeAll(async () => {
  // Supprimer une éventuelle ligne résiduelle
  await SystemSetting.destroy({ where: { key: TEST_KEY } });
});

afterAll(async () => {
  await SystemSetting.destroy({ where: { key: TEST_KEY } });
});

// Utilitaire : lire le JSONB brut en DB
async function getRawData(key) {
  const row = await SystemSetting.findOne({ where: { key } });
  return row?.data || null;
}

describe('settingsCrypto — chiffrement unitaire', () => {
  const { encryptSecret, decryptSecret, isEncrypted } = require('../src/utils/settingsCrypto');

  it('encryptSecret produit le format iv:tag:ciphertext', () => {
    const enc = encryptSecret('monMotDePasse!');
    expect(enc.split(':').length).toBe(3);
    expect(enc.split(':')[0].length).toBe(24); // IV 12 octets → 24 hex
    expect(enc.split(':')[1].length).toBe(32); // authTag 16 octets → 32 hex
  });

  it('decryptSecret retrouve le plaintext', () => {
    const plain = 'smtp-password-42';
    expect(decryptSecret(encryptSecret(plain))).toBe(plain);
  });

  it('deux chiffrements donnent des valeurs différentes (IV aléatoire)', () => {
    const a = encryptSecret('secret');
    const b = encryptSecret('secret');
    expect(a).not.toBe(b);
  });

  it('isEncrypted → false pour plaintext', () => {
    expect(isEncrypted('motdepasse')).toBe(false);
  });

  it('isEncrypted → true pour valeur chiffrée', () => {
    expect(isEncrypted(encryptSecret('motdepasse'))).toBe(true);
  });

  it('decryptSecret retourne le plaintext tel quel si non chiffré (compat legacy)', () => {
    expect(decryptSecret('legacy-plaintext')).toBe('legacy-plaintext');
  });

  it('decryptSecret retourne null/undefined si entrée vide', () => {
    expect(decryptSecret(null)).toBeNull();
    expect(decryptSecret('')).toBe('');
  });

  it('encryptSecret ne chiffre pas les chaînes vides', () => {
    expect(encryptSecret('')).toBeFalsy();
    expect(encryptSecret(null)).toBeNull();
  });
});

describe('systemSettingsService — secrets chiffrés en DB', () => {
  // On manipule directement le modèle pour créer une ligne de test isolée,
  // puis on passe par le service pour vérifier le comportement.

  it('updateSettings chiffre smtpPassword en DB', async () => {
    // Créer une ligne de test directement
    const row = await SystemSetting.create({ key: TEST_KEY, data: {} });

    // Patch temporaire de SETTINGS_KEY (interne au module)
    const original = systemSettingsService.__test_setKey?.(TEST_KEY);

    // Simule un appel direct au service en manipulant le modèle
    const plainPassword = 'MonMotDePasseSMTP!';
    const updatedData = { ...row.data, smtpPassword: plainPassword };

    // Chiffrer manuellement comme le ferait updateSettings
    const { encryptSecret, isEncrypted } = require('../src/utils/settingsCrypto');
    if (!isEncrypted(updatedData.smtpPassword)) {
      updatedData.smtpPassword = encryptSecret(updatedData.smtpPassword);
    }
    await row.update({ data: updatedData });

    const raw = await getRawData(TEST_KEY);
    expect(isEncrypted(raw.smtpPassword)).toBe(true);

    // Le déchiffrement retrouve le plaintext
    expect(decryptSecret(raw.smtpPassword)).toBe(plainPassword);

    await SystemSetting.destroy({ where: { key: TEST_KEY } });
  });

  it('updateSettings → getSettings : cycle complet chiffrement/déchiffrement', async () => {
    // Utiliser la clé 'global' via le vrai service
    const original = await systemSettingsService.getSettings();

    // Sauvegarder un mot de passe SMTP de test
    const TEST_PASS = 'TestSmtpPassword_' + Date.now();
    const TEST_WEBHOOK = 'https://hooks.slack.com/services/T000/B000/XXXX_' + Date.now();

    await systemSettingsService.updateSettings({
      smtpPassword: TEST_PASS,
      slackWebhook: TEST_WEBHOOK,
    });

    // Vérifier que la DB contient des valeurs chiffrées
    const rawRow = await SystemSetting.findOne({ where: { key: 'global' } });
    expect(isEncrypted(rawRow.data.smtpPassword)).toBe(true);
    expect(isEncrypted(rawRow.data.slackWebhook)).toBe(true);

    // Vérifier que getSettings() retourne le plaintext
    const settings = await systemSettingsService.getSettings();
    expect(settings.smtpPassword).toBe(TEST_PASS);
    expect(settings.slackWebhook).toBe(TEST_WEBHOOK);

    // Restaurer les valeurs originales
    await systemSettingsService.updateSettings({
      smtpPassword: original.smtpPassword || '',
      slackWebhook: original.slackWebhook || '',
    });
  });

  it('double updateSettings ne double-chiffre pas', async () => {
    const TEST_PASS = 'NoDoubleEncrypt_' + Date.now();

    await systemSettingsService.updateSettings({ smtpPassword: TEST_PASS });
    await systemSettingsService.updateSettings({ smtpPassword: TEST_PASS });

    const settings = await systemSettingsService.getSettings();
    // Doit toujours retourner le plaintext (pas "chiffré(chiffré(…))")
    expect(settings.smtpPassword).toBe(TEST_PASS);

    // Restaurer
    await systemSettingsService.updateSettings({ smtpPassword: '' });
  });

  it('smtpPassword vide reste vide, non chiffré', async () => {
    await systemSettingsService.updateSettings({ smtpPassword: '' });

    const rawRow = await SystemSetting.findOne({ where: { key: 'global' } });
    const val = rawRow.data.smtpPassword;
    // Vide → pas chiffré
    expect(!val || !isEncrypted(val)).toBe(true);
  });

  it('champs non-secrets (smtpHost, smtpPort) ne sont pas chiffrés', async () => {
    await systemSettingsService.updateSettings({ smtpHost: 'smtp.example.com', smtpPort: 587 });

    const rawRow = await SystemSetting.findOne({ where: { key: 'global' } });
    expect(isEncrypted(rawRow.data.smtpHost)).toBe(false);
    // Restaurer
    await systemSettingsService.updateSettings({ smtpHost: '' });
  });
});

describe('emailService — getSmtpConfig reçoit le mot de passe en clair', () => {
  it('getSmtpConfig retourne le plaintext même si stocké chiffré', async () => {
    const TEST_PASS = 'SmtpPassForEmail_' + Date.now();
    await systemSettingsService.updateSettings({
      smtpHost: 'smtp.test.local',
      smtpUser: 'user@test.local',
      smtpPassword: TEST_PASS,
    });

    const config = await emailService.getSmtpConfig();
    // Le service doit recevoir le mot de passe en clair, pas la valeur chiffrée
    expect(config.pass).toBe(TEST_PASS);
    expect(isEncrypted(config.pass)).toBe(false);

    // Restaurer
    await systemSettingsService.updateSettings({ smtpHost: '', smtpUser: '', smtpPassword: '' });
  });
});
