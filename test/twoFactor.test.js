'use strict';
/**
 * twoFactor.test.js — Tests d'intégration : authentification à deux facteurs (2FA)
 *
 * Couvre :
 *  - Setup (génération du secret TOTP)
 *  - Enable avec code valide
 *  - Login → retourne pending_token si 2FA actif
 *  - verify2FA avec code valide → retourne session complète
 *  - Disable avec mot de passe
 *  - Rejets (code invalide, token invalide, mot de passe incorrect)
 */

const request = require('supertest');
const speakeasy = require('speakeasy');
const app = require('../src/index');
const { seed, TEST_PASSWORD } = require('./helpers/seed');
const { Utilisateur } = require('../src/models');

let ctx;

beforeAll(async () => {
  ctx = await seed();
});

afterAll(async () => {
  // S'assurer que le 2FA est désactivé pour le cleanup propre
  await Utilisateur.update(
    { totp_secret: null, totp_enabled: false },
    { where: { entreprise_id: ctx.entreprise.id } }
  );
  await ctx.cleanup();
});

// ---------------------------------------------------------------------------
describe('POST /api/2fa/setup — initialisation du secret TOTP', () => {
  it('200 — retourne secret et QR code', async () => {
    const res = await request(app)
      .post('/api/2fa/setup')
      .set('Authorization', `Bearer ${ctx.tokens.employe}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('secret');
    expect(res.body).toHaveProperty('qrCode');
    expect(typeof res.body.secret).toBe('string');
    expect(res.body.secret.length).toBeGreaterThan(10);
  });

  it('401 sans token', async () => {
    const res = await request(app).post('/api/2fa/setup');
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
describe('POST /api/2fa/enable — activation avec code TOTP', () => {
  let totpSecret;

  beforeAll(async () => {
    // Setup pour obtenir le secret
    const setupRes = await request(app)
      .post('/api/2fa/setup')
      .set('Authorization', `Bearer ${ctx.tokens.employe}`);

    totpSecret = setupRes.body.secret;
  });

  it('400 si code absent', async () => {
    const res = await request(app)
      .post('/api/2fa/enable')
      .set('Authorization', `Bearer ${ctx.tokens.employe}`)
      .send({});

    expect(res.status).toBe(400);
  });

  it('400 si code invalide (mauvais token)', async () => {
    const res = await request(app)
      .post('/api/2fa/enable')
      .set('Authorization', `Bearer ${ctx.tokens.employe}`)
      .send({ code: '000000' });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/invalide/i);
  });

  it('200 avec code TOTP valide — active le 2FA', async () => {
    if (!totpSecret) return;

    const validCode = speakeasy.totp({
      secret: totpSecret,
      encoding: 'base32',
    });

    const res = await request(app)
      .post('/api/2fa/enable')
      .set('Authorization', `Bearer ${ctx.tokens.employe}`)
      .send({ code: validCode });

    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/activé/i);

    // Vérifier en DB que totp_enabled = true
    const user = await Utilisateur.findByPk(ctx.employe.id);
    expect(user.totp_enabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('POST /api/auth/login — flow 2FA (pending_token)', () => {
  it('retourne requires2fa=true et pending_token quand 2FA actif', async () => {
    // L'employé a activé le 2FA dans le describe précédent
    const user = await Utilisateur.findByPk(ctx.employe.id);
    if (!user?.totp_enabled) return; // skip si 2FA non activé (test précédent skippé)

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: ctx.employe.email, password: TEST_PASSWORD });

    // Le login doit retourner un état pending (pas de token complet)
    expect(res.status).toBe(200);
    expect(res.body.requires2fa).toBe(true);
    expect(res.body).toHaveProperty('pending_token');
    expect(res.body).not.toHaveProperty('token'); // pas de session complète
  });
});

// ---------------------------------------------------------------------------
describe('POST /api/2fa/verify — vérification du code 2FA', () => {
  let pendingToken;
  let totpSecret;

  beforeAll(async () => {
    const user = await Utilisateur.findByPk(ctx.employe.id);
    if (!user?.totp_enabled) return;

    totpSecret = user.totp_secret;

    // Obtenir un pending_token via login
    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ email: ctx.employe.email, password: TEST_PASSWORD });

    pendingToken = loginRes.body.pending_token;
  });

  it('400 si pending_token ou code absent', async () => {
    const res = await request(app)
      .post('/api/2fa/verify')
      .send({ pending_token: 'token-seulement' }); // code manquant

    expect(res.status).toBe(400);
  });

  it('401 si pending_token invalide', async () => {
    const res = await request(app)
      .post('/api/2fa/verify')
      .send({ pending_token: 'invalid.jwt.token', code: '123456' });

    expect(res.status).toBe(401);
  });

  it('400 si code TOTP invalide', async () => {
    if (!pendingToken) return;

    const res = await request(app)
      .post('/api/2fa/verify')
      .send({ pending_token: pendingToken, code: '000000' });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/invalide/i);
  });

  it('200 avec code valide — retourne token de session complet', async () => {
    if (!pendingToken || !totpSecret) return;

    const validCode = speakeasy.totp({
      secret: totpSecret,
      encoding: 'base32',
    });

    const res = await request(app)
      .post('/api/2fa/verify')
      .send({ pending_token: pendingToken, code: validCode });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('token');
    expect(res.body).toHaveProperty('utilisateur');
    expect(res.body.utilisateur.id).toBe(ctx.employe.id);
  });
});

// ---------------------------------------------------------------------------
describe('POST /api/2fa/disable — désactivation', () => {
  it('400 si mot de passe absent', async () => {
    const res = await request(app)
      .post('/api/2fa/disable')
      .set('Authorization', `Bearer ${ctx.tokens.employe}`)
      .send({});

    expect(res.status).toBe(400);
  });

  it('400 si mot de passe incorrect', async () => {
    const res = await request(app)
      .post('/api/2fa/disable')
      .set('Authorization', `Bearer ${ctx.tokens.employe}`)
      .send({ password: 'mauvais_mot_de_passe' });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/incorrect/i);
  });

  it('200 avec mot de passe correct — désactive le 2FA', async () => {
    const user = await Utilisateur.findByPk(ctx.employe.id);
    if (!user?.totp_enabled) return;

    const res = await request(app)
      .post('/api/2fa/disable')
      .set('Authorization', `Bearer ${ctx.tokens.employe}`)
      .send({ password: TEST_PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/désactivé/i);

    // Vérifier en DB
    const updated = await Utilisateur.findByPk(ctx.employe.id);
    expect(updated.totp_enabled).toBe(false);
    expect(updated.totp_secret).toBeNull();
  });
});
