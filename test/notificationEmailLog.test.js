'use strict';

const nodemailer = require('nodemailer');
const notificationService = require('../src/services/notificationService');
const systemSettingsService = require('../src/services/systemSettingsService');
const { Entreprise, Utilisateur, EmailLog } = require('../src/models');

const TEST_RUN_ID = Date.now();
const successEmail = `audit.success.${TEST_RUN_ID}@test.internal`;
const failedEmail = `audit.failed.${TEST_RUN_ID}@test.internal`;

let entreprise;
let utilisateur;
let getSettingsSpy;
let createTransportSpy;
let originalEnv;

beforeAll(async () => {
  entreprise = await Entreprise.create({
    nom: `EmailLog_${TEST_RUN_ID}`,
    politique_conges: {},
    parametres: {},
    statut: 'active',
  });
  utilisateur = await Utilisateur.create({
    entreprise_id: entreprise.id,
    prenom: 'Email',
    nom: 'Audit',
    email: successEmail,
    role: 'employe',
    password_hash: 'test-hash',
    statut: 'actif',
  });
});

beforeEach(() => {
  originalEnv = {
    GMAIL_CLIENT_ID: process.env.GMAIL_CLIENT_ID,
    GMAIL_CLIENT_SECRET: process.env.GMAIL_CLIENT_SECRET,
    GMAIL_REFRESH_TOKEN: process.env.GMAIL_REFRESH_TOKEN,
    RESEND_API_KEY: process.env.RESEND_API_KEY,
  };
  delete process.env.GMAIL_CLIENT_ID;
  delete process.env.GMAIL_CLIENT_SECRET;
  delete process.env.GMAIL_REFRESH_TOKEN;
  delete process.env.RESEND_API_KEY;

  getSettingsSpy = jest.spyOn(systemSettingsService, 'getSettings').mockResolvedValue({
    ...systemSettingsService.DEFAULT_SETTINGS,
    emailNotifications: true,
    smtpHost: 'localhost',
    smtpPort: 2525,
    smtpUser: 'test',
    smtpPassword: 'test',
  });
});

afterEach(() => {
  getSettingsSpy?.mockRestore();
  createTransportSpy?.mockRestore();
  createTransportSpy = null;

  for (const [key, value] of Object.entries(originalEnv || {})) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

afterAll(async () => {
  await EmailLog.destroy({ where: { to_address: [successEmail, failedEmail] } });
  await Utilisateur.destroy({ where: { id: utilisateur?.id } });
  await Entreprise.destroy({ where: { id: entreprise?.id } });
});

describe('notification email audit log', () => {
  it('records successful SMTP sends and associates the recipient', async () => {
    const sendMail = jest.fn().mockResolvedValue({ messageId: 'smtp-audit-success' });
    createTransportSpy = jest.spyOn(nodemailer, 'createTransport').mockReturnValue({ sendMail });

    await notificationService.sendEmail({
      to: successEmail,
      subject: 'Confirmation de congé',
      html: '<p>Votre demande a été reçue.</p>',
      data: { email_type: 'leave-created-employee' },
    });

    const log = await EmailLog.findOne({ where: { to_address: successEmail } });
    expect(log).toMatchObject({
      type: 'leave-created-employee',
      statut: 'success',
      provider: 'smtp',
      message_id: 'smtp-audit-success',
      entreprise_id: entreprise.id,
      utilisateur_id: utilisateur.id,
    });
  });

  it('records failed SMTP sends without swallowing the error', async () => {
    const sendMail = jest.fn().mockRejectedValue(new Error('SMTP unavailable'));
    createTransportSpy = jest.spyOn(nodemailer, 'createTransport').mockReturnValue({ sendMail });

    await expect(notificationService.sendEmail({
      to: failedEmail,
      subject: 'Notification échouée',
      html: '<p>Test</p>',
      data: { email_type: 'leave-action-request-admin' },
    })).rejects.toThrow('SMTP unavailable');

    const log = await EmailLog.findOne({ where: { to_address: failedEmail } });
    expect(log).toMatchObject({
      type: 'leave-action-request-admin',
      statut: 'failed',
      provider: 'smtp',
      error_message: 'SMTP unavailable',
    });
  });
});