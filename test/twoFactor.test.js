'use strict';
/**
 * twoFactor.test.js — Tests d'intégration : authentification à deux facteurs (2FA)
 *
 * Couvre :
 *  - Setup (génération du secret TOTP, stocké chiffré en DB)
 *  - Enable avec code valide
 *  - Login → retourne pending_token si 2FA actif
 *  - verify2FA avec code valide → retourne session complète
 *  - Disable avec mot de passe
 *  - Rejets (code invalide, token invalide, mot de passe incorrect)
 *  - Migration : utilisateur avec secret legacy plaintext peut toujours se connecter
 */

const request  = require('supertest');
const speakeasy = require('speakeasy');
const app      = require('../src/index');
const { seed, TEST_PASSWORD } = require('./helpers/seed');
const { Utilisateur } = require('../src/models');
const { encryptTotpSecret, decryptTotpSecret, isEncrypted } = require('../src/utils/totpCrypto');

let ctx;

beforeAll(async () => {
  ctx = await seed();
});

afterAll(async () => {
  await Utilisateur.update(
    { totp_secret: null, totp_enabled: false },
    { where: { entreprise_id: ctx.entreprise.id } }
  );
  await ctx.cleanup();
});

// ---------------------------------------------------------------------------
describe('GET /api/auth/2fa/setup — initialisation du secret TOTP', () => {
  it('200 — retourne secret et QR code', async () => {
    const res = await request(app)
      .get('/api/auth/2fa/setup')
      .set('Authorization', `Bearer ${ctx.tokens.employe}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('secret');
    expect(res.body).toHaveProperty('qrCode');
    expect(typeof res.body.secret).toBe('string');
    expect(res.body.secret.length).toBeGreaterThan(10);
  });

  it('401 sans token', async () => {
    const res = await request(app).get('/api/auth/2fa/setup');
    expect(res.status).toBe(401);
  });

  it('le secret est stocké chiffré en DB (format iv:tag:ciphertext)', async () => {
    const user = await Utilisateur.findByPk(ctx.employe.id);
    expect(user.totp_secret).not.toBeNull();
    expect(isEncrypted(user.totp_secret)).toBe(true);
    // Doit contenir 2 séparateurs ':'
    expect(user.totp_secret.split(':').length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
describe('POST /api/auth/2fa/enable — activation avec code TOTP', () => {
  let totpSecret;

  beforeAll(async () => {
    const setupRes = await request(app)
      .get('/api/auth/2fa/setup')
      .set('Authorization', `Bearer ${ctx.tokens.employe}`);

    // Le secret retourné par l'API est en plaintext (pour l'appli authenticator)
    totpSecret = setupRes.body.secret;
  });

  it('400 si code absent', async () => {
    const res = await request(app)
      .post('/api/auth/2fa/enable')
      .set('Authorization', `Bearer ${ctx.tokens.employe}`)
      .send({});

    expect(res.status).toBe(400);
  });

  it('400 si code invalide', async () => {
    const res = await request(app)
      .post('/api/auth/2fa/enable')
      .set('Authorization', `Bearer ${ctx.tokens.employe}`)
      .send({ code: '000000' });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/invalide/i);
  });

  it('200 avec code TOTP valide — active le 2FA', async () => {
    if (!totpSecret) return;

    const validCode = speakeasy.totp({ secret: totpSecret, encoding: 'base32' });

    const res = await request(app)
      .post('/api/auth/2fa/enable')
      .set('Authorization', `Bearer ${ctx.tokens.employe}`)
      .send({ code: validCode });

    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/activ/i);

    const user = await Utilisateur.findByPk(ctx.employe.id);
    expect(user.totp_enabled).toBe(true);
    // Secret toujours chiffré après activation
    expect(isEncrypted(user.totp_secret)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('POST /api/auth/login — flow 2FA (pending_token)', () => {
  it('retourne requires2fa=true et pending_token quand 2FA actif', async () => {
    const user = await Utilisateur.findByPk(ctx.employe.id);
    if (!user?.totp_enabled) return;

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: ctx.employe.email, password: TEST_PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.requires2fa).toBe(true);
    expect(res.body).toHaveProperty('pending_token');
    expect(res.body).not.toHaveProperty('token');
  });
});

// ---------------------------------------------------------------------------
describe('POST /api/auth/2fa/verify — vérification du code 2FA', () => {
  let pendingToken;
  let plaintextSecret;

  beforeAll(async () => {
    const user = await Utilisateur.findByPk(ctx.employe.id);
    if (!user?.totp_enabled) return;

    // Déchiffrer le secret stocké en DB pour générer un code TOTP valide
    plaintextSecret = decryptTotpSecret(user.totp_secret);

    // Réinitialiser l'anti-replay : enable2FA (describe précédent) a consommé un code
    // dans la même fenêtre 30 s ; simuler ici qu'une fenêtre s'est écoulée.
    await Utilisateur.update(
      { totp_used_at: null, totp_used_token: null },
      { where: { id: ctx.employe.id } }
    );

    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ email: ctx.employe.email, password: TEST_PASSWORD });

    pendingToken = loginRes.body.pending_token;
  });

  it('400 si pending_token ou code absent', async () => {
    const res = await request(app)
      .post('/api/auth/2fa/verify')
      .send({ pending_token: 'token-seulement' });

    expect(res.status).toBe(400);
  });

  it('401 si pending_token invalide', async () => {
    const res = await request(app)
      .post('/api/auth/2fa/verify')
      .send({ pending_token: 'invalid.jwt.token', code: '123456' });

    expect(res.status).toBe(401);
  });

  it('400 si code TOTP invalide', async () => {
    if (!pendingToken) return;

    const res = await request(app)
      .post('/api/auth/2fa/verify')
      .send({ pending_token: pendingToken, code: '000000' });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/invalide/i);
  });

  it('200 avec code valide — retourne token de session complet', async () => {
    if (!pendingToken || !plaintextSecret) return;

    const validCode = speakeasy.totp({ secret: plaintextSecret, encoding: 'base32' });

    const res = await request(app)
      .post('/api/auth/2fa/verify')
      .send({ pending_token: pendingToken, code: validCode });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('token');
    expect(res.body).toHaveProperty('utilisateur');
    expect(res.body.utilisateur.id).toBe(ctx.employe.id);
  });
});

// ---------------------------------------------------------------------------
describe('POST /api/auth/2fa/disable — désactivation', () => {
  it('400 si mot de passe absent', async () => {
    const res = await request(app)
      .post('/api/auth/2fa/disable')
      .set('Authorization', `Bearer ${ctx.tokens.employe}`)
      .send({});

    expect(res.status).toBe(400);
  });

  it('400 si mot de passe incorrect', async () => {
    const res = await request(app)
      .post('/api/auth/2fa/disable')
      .set('Authorization', `Bearer ${ctx.tokens.employe}`)
      .send({ password: 'mauvais_mot_de_passe' });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/incorrect/i);
  });

  it('200 avec mot de passe correct — désactive le 2FA', async () => {
    const user = await Utilisateur.findByPk(ctx.employe.id);
    if (!user?.totp_enabled) return;

    const res = await request(app)
      .post('/api/auth/2fa/disable')
      .set('Authorization', `Bearer ${ctx.tokens.employe}`)
      .send({ password: TEST_PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/désactiv/i);

    const updated = await Utilisateur.findByPk(ctx.employe.id);
    expect(updated.totp_enabled).toBe(false);
    expect(updated.totp_secret).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe('Migration — secret TOTP legacy (plaintext) reste fonctionnel', () => {
  // Simule un utilisateur dont le secret n'a pas encore été migré vers le chiffrement.
  // decryptTotpSecret() doit retourner le plaintext tel quel (backward compat).
  it('decryptTotpSecret retourne le plaintext si le secret n\'est pas chiffré', () => {
    const legacy = 'JBSWY3DPEHPK3PXP';
    expect(decryptTotpSecret(legacy)).toBe(legacy);
  });

  it('isEncrypted retourne false pour un secret legacy', () => {
    expect(isEncrypted('JBSWY3DPEHPK3PXP')).toBe(false);
  });

  it('isEncrypted retourne true pour un secret chiffré', () => {
    const encrypted = encryptTotpSecret('JBSWY3DPEHPK3PXP');
    expect(isEncrypted(encrypted)).toBe(true);
  });

  it('un code TOTP généré sur plaintext reste valide après chiffrement/déchiffrement', () => {
    const plaintext  = 'JBSWY3DPEHPK3PXP';
    const encrypted  = encryptTotpSecret(plaintext);
    const decrypted  = decryptTotpSecret(encrypted);

    const code = speakeasy.totp({ secret: plaintext,  encoding: 'base32' });
    const ok   = speakeasy.totp.verify({ secret: decrypted, encoding: 'base32', token: code, window: 1 });
    expect(ok).toBe(true);
  });
});
