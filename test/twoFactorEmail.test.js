'use strict';
/**
 * twoFactorEmail.test.js
 *
 * Vérifie que send2FAEnabled et send2FADisabled sont envoyés lors de
 * l'activation et la désactivation du 2FA.
 *
 * Cas testés :
 *   A) POST /api/auth/2fa/enable avec code TOTP valide → send2FAEnabled appelé
 *   B) POST /api/auth/2fa/disable avec mot de passe valide → send2FADisabled appelé
 *   C) POST /api/auth/2fa/enable avec code invalide → send2FAEnabled NON appelé
 */

const request    = require('supertest');
const speakeasy  = require('speakeasy');
const app        = require('../src/index');
const emailService = require('../src/services/emailService');
const { seed, TEST_PASSWORD } = require('./helpers/seed');
const { Utilisateur } = require('../src/models');

let ctx;

beforeAll(async () => {
  ctx = await seed();
});

afterAll(async () => {
  // Remettre l'utilisateur dans un état propre (2FA off)
  await Utilisateur.update(
    { totp_secret: null, totp_enabled: false, totp_used_token: null, totp_used_at: null },
    { where: { id: ctx.employe.id } }
  );
  await ctx.cleanup();
});

// ─── CAS A : Activation 2FA → send2FAEnabled ─────────────────────────────────

describe('CAS A — activation 2FA avec code valide → send2FAEnabled appelé', () => {
  let spy;
  let totpSecret;

  beforeAll(async () => {
    // Remettre le compte sans 2FA
    await Utilisateur.update(
      { totp_secret: null, totp_enabled: false, totp_used_token: null, totp_used_at: null },
      { where: { id: ctx.employe.id } }
    );

    // Setup : génère et stocke le secret
    const setupRes = await request(app)
      .get('/api/auth/2fa/setup')
      .set('Authorization', `Bearer ${ctx.tokens.employe}`);
    totpSecret = setupRes.body.secret;

    spy = jest.spyOn(emailService, 'send2FAEnabled').mockResolvedValue(undefined);

    const validCode = speakeasy.totp({ secret: totpSecret, encoding: 'base32' });
    await request(app)
      .post('/api/auth/2fa/enable')
      .set('Authorization', `Bearer ${ctx.tokens.employe}`)
      .send({ code: validCode });
  });

  afterAll(() => spy.mockRestore());

  it('send2FAEnabled est appelé une fois', () => {
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('le destinataire est l\'utilisateur qui a activé le 2FA', () => {
    const [utilisateur] = spy.mock.calls[0];
    expect(utilisateur.id).toBe(ctx.employe.id);
  });
});

// ─── CAS B : Désactivation 2FA → send2FADisabled ─────────────────────────────

describe('CAS B — désactivation 2FA avec mot de passe valide → send2FADisabled appelé', () => {
  let spy;

  beforeAll(async () => {
    // S'assurer que le 2FA est bien activé (hérité du CAS A ou forcé en DB)
    const user = await Utilisateur.findByPk(ctx.employe.id);
    if (!user.totp_enabled) {
      // Forcer l'état 2FA actif sans passer par l'API (secret factice suffisant pour ce test)
      const secret = speakeasy.generateSecret({ length: 20 });
      const { encryptTotpSecret } = require('../src/utils/totpCrypto');
      await Utilisateur.update(
        { totp_secret: encryptTotpSecret(secret.base32), totp_enabled: true },
        { where: { id: ctx.employe.id } }
      );
    }

    spy = jest.spyOn(emailService, 'send2FADisabled').mockResolvedValue(undefined);

    await request(app)
      .post('/api/auth/2fa/disable')
      .set('Authorization', `Bearer ${ctx.tokens.employe}`)
      .send({ password: TEST_PASSWORD });
  });

  afterAll(() => spy.mockRestore());

  it('send2FADisabled est appelé une fois', () => {
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('le destinataire est l\'utilisateur qui a désactivé le 2FA', () => {
    const [utilisateur] = spy.mock.calls[0];
    expect(utilisateur.id).toBe(ctx.employe.id);
  });
});

// ─── CAS C : Code TOTP invalide → send2FAEnabled NON appelé ──────────────────

describe('CAS C — code TOTP invalide → send2FAEnabled NON appelé', () => {
  let spy;

  beforeAll(async () => {
    // Setup uniquement (pas d'activation)
    await Utilisateur.update(
      { totp_secret: null, totp_enabled: false, totp_used_token: null, totp_used_at: null },
      { where: { id: ctx.employe.id } }
    );
    await request(app)
      .get('/api/auth/2fa/setup')
      .set('Authorization', `Bearer ${ctx.tokens.employe}`);

    spy = jest.spyOn(emailService, 'send2FAEnabled').mockResolvedValue(undefined);

    await request(app)
      .post('/api/auth/2fa/enable')
      .set('Authorization', `Bearer ${ctx.tokens.employe}`)
      .send({ code: '000000' }); // code invalide
  });

  afterAll(() => spy.mockRestore());

  it('send2FAEnabled n\'est pas appelé', () => {
    expect(spy).not.toHaveBeenCalled();
  });
});
