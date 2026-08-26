'use strict';
/**
 * settingsPasswordLeak.test.js
 *
 * BILAN #22 — GET /api/settings renvoie smtpPassword en clair.
 *
 * AVANT fix : le champ smtpPassword est présent et lisible dans la réponse HTTP.
 * APRÈS fix  : smtpPassword est absent ; smtpPasswordSet (boolean) indique si un
 *              mot de passe est configuré. Même masquage pour slackWebhook.
 */

const request = require('supertest');
const app = require('../src/index');
const { seed } = require('./helpers/seed');
const systemSettingsService = require('../src/services/systemSettingsService');

let ctx;
const TEST_PASS = 'SuperSecretSMTP_' + Date.now();
const TEST_WEBHOOK = 'https://hooks.slack.com/XXXX_' + Date.now();

beforeAll(async () => {
  ctx = await seed();
  // Configurer un mot de passe SMTP et un webhook pour que les champs soient non-vides
  await systemSettingsService.updateSettings({
    smtpPassword: TEST_PASS,
    slackWebhook: TEST_WEBHOOK,
  });
});

afterAll(async () => {
  // Restaurer des valeurs vides
  await systemSettingsService.updateSettings({ smtpPassword: '', slackWebhook: '' });
  await ctx.cleanup();
});

describe('GET /api/settings — masquage des secrets', () => {
  it('smtpPassword est ABSENT de la réponse (AVANT fix : présent en clair)', async () => {
    const res = await request(app)
      .get('/api/settings')
      .set('Authorization', `Bearer ${ctx.tokens.superAdmin}`);

    expect(res.status).toBe(200);
    // AVANT fix : smtpPassword est présent dans la réponse (bug)
    // APRÈS fix  : smtpPassword est absent (corrigé)
    expect(res.body).not.toHaveProperty('smtpPassword');
  });

  it('smtpPasswordSet (boolean) est présent dans la réponse', async () => {
    const res = await request(app)
      .get('/api/settings')
      .set('Authorization', `Bearer ${ctx.tokens.superAdmin}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('smtpPasswordSet', true);
  });

  it('slackWebhook est ABSENT de la réponse', async () => {
    const res = await request(app)
      .get('/api/settings')
      .set('Authorization', `Bearer ${ctx.tokens.superAdmin}`);

    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('slackWebhook');
  });

  it('slackWebhookSet (boolean) est présent dans la réponse', async () => {
    const res = await request(app)
      .get('/api/settings')
      .set('Authorization', `Bearer ${ctx.tokens.superAdmin}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('slackWebhookSet', true);
  });

  it('smtpPasswordSet = false si aucun mot de passe configuré', async () => {
    await systemSettingsService.updateSettings({ smtpPassword: '' });

    const res = await request(app)
      .get('/api/settings')
      .set('Authorization', `Bearer ${ctx.tokens.superAdmin}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('smtpPasswordSet', false);
    expect(res.body).not.toHaveProperty('smtpPassword');

    // Restaurer
    await systemSettingsService.updateSettings({ smtpPassword: TEST_PASS });
  });
});

describe('PUT /api/settings/sections/email — masquage dans la réponse de mise à jour', () => {
  it('la réponse de PUT ne contient pas smtpPassword en clair', async () => {
    const res = await request(app)
      .put('/api/settings/sections/email')
      .set('Authorization', `Bearer ${ctx.tokens.superAdmin}`)
      .send({ smtpHost: 'smtp.example.com' });

    expect(res.status).toBe(200);
    const settings = res.body?.settings;
    expect(settings).toBeDefined();
    expect(settings).not.toHaveProperty('smtpPassword');
    expect(settings).toHaveProperty('smtpPasswordSet');
  });

  it('envoyer smtpPassword vide dans PUT ne réinitialise pas le mot de passe existant', async () => {
    // L'admin ne touche pas le champ password → envoie chaîne vide (frontend skip)
    // Le mot de passe stocké doit rester inchangé
    await request(app)
      .put('/api/settings/sections/email')
      .set('Authorization', `Bearer ${ctx.tokens.superAdmin}`)
      .send({ smtpHost: 'smtp.example.com', smtpPassword: '' });

    // Vérifier en interne que le mot de passe n'a pas été effacé
    const internal = await systemSettingsService.getSettings();
    expect(internal.smtpPassword).toBe(TEST_PASS);
  });
});
