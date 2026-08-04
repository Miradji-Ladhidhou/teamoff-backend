'use strict';
/**
 * notificationFlags.test.js — Fix #47
 *
 * Les flags emailNotifications / pushNotifications stockés dans SystemSetting
 * ne sont jamais consultés avant l'envoi : les emails et les pushs SSE partent
 * même quand l'admin a désactivé la fonctionnalité.
 *
 * AVANT fix : creerNotification appelle toujours sseManager.sendToUser,
 *             sendEmail tente toujours l'envoi SMTP/Gmail/Resend.
 * APRÈS fix  : les flags sont lus et l'envoi est court-circuité si désactivé.
 *
 * Cas testés :
 *   A) pushNotifications=false  → sseManager.sendToUser NON appelé
 *   B) pushNotifications=true   → sseManager.sendToUser appelé (non-régression)
 *   C) emailNotifications=false → sendEmail retourne undefined immédiatement
 *   D) emailNotifications=true  → sendEmail passe le flag et atteint l'envoi
 */

const sseManager            = require('../src/services/sseManager');
const notificationService   = require('../src/services/notificationService');
const systemSettingsService = require('../src/services/systemSettingsService');
const { Entreprise, Utilisateur, Notification } = require('../src/models');
const bcrypt = require('bcrypt');

const TS = Date.now();

let ent, user;

beforeAll(async () => {
  const hash = await bcrypt.hash('Test1234!', 10);
  ent = await Entreprise.create({
    nom: `NotifFlags_${TS}`, politique_conges: {}, parametres: {}, statut: 'active',
  });
  user = await Utilisateur.create({
    entreprise_id: ent.id, prenom: 'Test', nom: `47`,
    email: `notif.47.${TS}@test.internal`,
    role: 'employe', password_hash: hash, statut: 'actif',
  });
  // État de départ : les deux flags sont actifs
  await systemSettingsService.updateSettings({ pushNotifications: true, emailNotifications: true });
});

afterAll(async () => {
  // Toujours restaurer les flags à true même si un test échoue
  await systemSettingsService.updateSettings({ pushNotifications: true, emailNotifications: true }).catch(() => {});
  await Notification.destroy({ where: { utilisateur_id: user?.id } }).catch(() => {});
  await Entreprise.destroy({ where: { id: ent?.id } }).catch(() => {});
});

// ─────────────────────────────────────────────────────────────────────────────
// A) pushNotifications=false → SSE push supprimé, notification DB préservée
// ─────────────────────────────────────────────────────────────────────────────

describe('Fix #47 — pushNotifications=false supprime le push SSE', () => {

  let sseSpy;

  beforeAll(async () => {
    await systemSettingsService.updateSettings({ pushNotifications: false });
  });

  afterAll(async () => {
    await systemSettingsService.updateSettings({ pushNotifications: true });
  });

  beforeEach(() => {
    sseSpy = jest.spyOn(sseManager, 'sendToUser').mockImplementation(() => {});
  });

  afterEach(() => {
    sseSpy.mockRestore();
  });

  it('AVANT fix : sendToUser appelé même si pushNotifications=false / APRÈS fix : NON appelé', async () => {
    await notificationService.creerNotification({
      entreprise_id: ent.id,
      utilisateur_id: user.id,
      type: 'test-push-off',
      message: 'push désactivé fix47',
    });
    expect(sseSpy).not.toHaveBeenCalled();
  });

  it('la notification DB est créée malgré le flag (push désactivé ≠ notification supprimée)', async () => {
    const notif = await Notification.findOne({
      where: { utilisateur_id: user.id, message: 'push désactivé fix47' },
    });
    expect(notif).not.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B) pushNotifications=true → SSE push envoyé (non-régression)
// ─────────────────────────────────────────────────────────────────────────────

describe('Fix #47 — pushNotifications=true : SSE push envoyé normalement', () => {

  let sseSpy;

  beforeEach(() => {
    sseSpy = jest.spyOn(sseManager, 'sendToUser').mockImplementation(() => {});
  });

  afterEach(() => {
    sseSpy.mockRestore();
  });

  it('sendToUser est appelé quand pushNotifications=true', async () => {
    await notificationService.creerNotification({
      entreprise_id: ent.id,
      utilisateur_id: user.id,
      type: 'test-push-on',
      message: 'push actif fix47',
    });
    expect(sseSpy).toHaveBeenCalledTimes(1);
    expect(sseSpy).toHaveBeenCalledWith(
      user.id, 'notification', expect.objectContaining({ type: 'test-push-on' }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C) emailNotifications=false → sendEmail retourne undefined immédiatement
// ─────────────────────────────────────────────────────────────────────────────

describe('Fix #47 — emailNotifications=false supprime l\'envoi email', () => {

  let getSettingsSpy;

  beforeEach(() => {
    // Intercepter getSettings pour retourner emailNotifications=false
    // (même instance de module qu'utilise notificationService.js → spy efficace)
    getSettingsSpy = jest.spyOn(systemSettingsService, 'getSettings').mockResolvedValue({
      ...systemSettingsService.DEFAULT_SETTINGS,
      emailNotifications: false,
    });
  });

  afterEach(() => {
    getSettingsSpy.mockRestore();
  });

  it('AVANT fix : sendEmail tente l\'envoi (erreur SMTP ou résultat) / APRÈS fix : retourne undefined', async () => {
    const result = await notificationService.sendEmail({
      to: `dest.47.${TS}@test.internal`,
      subject: 'Test emailNotifications désactivé',
      html: '<p>Ne doit pas être envoyé</p>',
    });
    // Après fix : early return avant tout accès SMTP/Gmail/Resend → undefined
    expect(result).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D) emailNotifications=true → sendEmail passe le flag et atteint l'envoi
// ─────────────────────────────────────────────────────────────────────────────

describe('Fix #47 — emailNotifications=true : sendEmail active (non-régression)', () => {

  let getSettingsSpy, createTransportSpy, sendMailMock;
  let savedGmailId, savedResendKey;

  beforeEach(() => {
    // Forcer le chemin nodemailer pour ne pas faire d'appels réels Gmail/Resend
    savedGmailId  = process.env.GMAIL_CLIENT_ID;
    savedResendKey = process.env.RESEND_API_KEY;
    delete process.env.GMAIL_CLIENT_ID;
    delete process.env.RESEND_API_KEY;

    getSettingsSpy = jest.spyOn(systemSettingsService, 'getSettings').mockResolvedValue({
      ...systemSettingsService.DEFAULT_SETTINGS,
      emailNotifications: true,
    });

    sendMailMock = jest.fn().mockResolvedValue({ messageId: 'mock-id-47' });
    createTransportSpy = jest.spyOn(require('nodemailer'), 'createTransport')
      .mockReturnValue({ sendMail: sendMailMock });
  });

  afterEach(() => {
    if (savedGmailId  !== undefined) process.env.GMAIL_CLIENT_ID  = savedGmailId;
    if (savedResendKey !== undefined) process.env.RESEND_API_KEY   = savedResendKey;
    getSettingsSpy.mockRestore();
    createTransportSpy.mockRestore();
  });

  it('createTransport et sendMail sont appelés quand emailNotifications=true (flag non court-circuité)', async () => {
    await notificationService.sendEmail({
      to: `dest.47b.${TS}@test.internal`,
      subject: 'Non-régression emailNotifications=true',
      html: '<p>Test</p>',
    });
    // Preuve que sendEmail a dépassé le flag et a tenté l'envoi SMTP
    expect(createTransportSpy).toHaveBeenCalledTimes(1);
    expect(sendMailMock).toHaveBeenCalledTimes(1);
  });
});
