'use strict';
/**
 * totpCrypto.test.js
 *
 * Couvre :
 *  - Chiffrement / déchiffrement AES-256-GCM du secret TOTP (unit)
 *  - Compatibilité secrets legacy en clair (rétrocompatibilité migration)
 *  - Flux 2FA end-to-end via l'API : setup → enable → verify
 *    (vérifie que le secret stocké en DB est bien chiffré)
 */

const speakeasy = require('speakeasy');
const request   = require('supertest');
const app       = require('../src/index');
const { seed }  = require('./helpers/seed');
const { Utilisateur } = require('../src/models');

// ---------------------------------------------------------------------------
// Unit — totpCrypto
// ---------------------------------------------------------------------------
describe('totpCrypto — chiffrement AES-256-GCM', () => {
  const { encryptTotpSecret, decryptTotpSecret, isEncrypted } = require('../src/utils/totpCrypto');

  const PLAINTEXT = 'JBSWY3DPEHPK3PXP'; // secret base32 fictif

  it('encryptTotpSecret retourne un format iv:tag:ciphertext', () => {
    const encrypted = encryptTotpSecret(PLAINTEXT);
    const parts = encrypted.split(':');
    expect(parts).toHaveLength(3);
    // IV 12 octets → 24 chars hex ; authTag 16 octets → 32 chars hex
    expect(parts[0]).toHaveLength(24);
    expect(parts[1]).toHaveLength(32);
    expect(parts[2].length).toBeGreaterThan(0);
  });

  it('encryptTotpSecret produit un ciphertext différent à chaque appel (IV aléatoire)', () => {
    const a = encryptTotpSecret(PLAINTEXT);
    const b = encryptTotpSecret(PLAINTEXT);
    expect(a).not.toBe(b);
  });

  it('decryptTotpSecret restitue le plaintext original', () => {
    const encrypted = encryptTotpSecret(PLAINTEXT);
    expect(decryptTotpSecret(encrypted)).toBe(PLAINTEXT);
  });

  it('decryptTotpSecret passe en clair les secrets legacy (pas de ":")', () => {
    // Secrets stockés avant la migration — doivent être lus sans erreur
    expect(decryptTotpSecret('LEGACYBASE32SECRET')).toBe('LEGACYBASE32SECRET');
  });

  it('decryptTotpSecret retourne null pour une valeur nulle', () => {
    expect(decryptTotpSecret(null)).toBeNull();
    expect(decryptTotpSecret(undefined)).toBeNull();
  });

  it('isEncrypted distingue chiffré et plaintext', () => {
    expect(isEncrypted(encryptTotpSecret(PLAINTEXT))).toBe(true);
    expect(isEncrypted('LEGACYPLAINTEXT')).toBe(false);
    expect(isEncrypted(null)).toBe(false);
  });

  it('encryptTotpSecret lance une erreur si TOTP_ENCRYPTION_KEY est absente', () => {
    const saved = process.env.TOTP_ENCRYPTION_KEY;
    delete process.env.TOTP_ENCRYPTION_KEY;
    expect(() => encryptTotpSecret(PLAINTEXT)).toThrow('TOTP_ENCRYPTION_KEY');
    process.env.TOTP_ENCRYPTION_KEY = saved;
  });

  it('encryptTotpSecret lance une erreur si TOTP_ENCRYPTION_KEY est malformée', () => {
    const saved = process.env.TOTP_ENCRYPTION_KEY;
    process.env.TOTP_ENCRYPTION_KEY = 'trop_court';
    expect(() => encryptTotpSecret(PLAINTEXT)).toThrow('64 caractères hexadécimaux');
    process.env.TOTP_ENCRYPTION_KEY = saved;
  });

  it('decryptTotpSecret échoue si le ciphertext est altéré (intégrité GCM)', () => {
    const encrypted = encryptTotpSecret(PLAINTEXT);
    const parts = encrypted.split(':');
    // Corrompre le ciphertext
    parts[2] = parts[2].slice(0, -2) + 'ff';
    expect(() => decryptTotpSecret(parts.join(':'))).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Intégration — flux 2FA via API
// ---------------------------------------------------------------------------
describe('2FA end-to-end — secret stocké chiffré en DB', () => {
  let ctx;

  beforeAll(async () => {
    ctx = await seed();
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it('setup2FA stocke un secret chiffré (format iv:tag:ciphertext) en DB', async () => {
    const res = await request(app)
      .get('/api/auth/2fa/setup')
      .set('Authorization', `Bearer ${ctx.tokens.employe}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('secret');
    expect(res.body).toHaveProperty('qrCode');

    // Vérifier que la valeur stockée en DB est bien chiffrée
    const user = await Utilisateur.findByPk(ctx.employe.id);
    expect(user.totp_secret).toBeTruthy();
    expect(user.totp_secret).toContain(':');
    const parts = user.totp_secret.split(':');
    expect(parts).toHaveLength(3);
  });

  it('enable2FA valide un code TOTP généré depuis le secret renvoyé par setup', async () => {
    // 1. Setup — récupère le secret en clair (retourné une seule fois au client)
    const setupRes = await request(app)
      .get('/api/auth/2fa/setup')
      .set('Authorization', `Bearer ${ctx.tokens.employe}`);

    expect(setupRes.status).toBe(200);
    const { secret } = setupRes.body;

    // 2. Générer un code TOTP valide depuis ce secret (window:1 = ±30s de marge)
    const code = speakeasy.totp({ secret, encoding: 'base32' });

    // 3. Activer le 2FA avec ce code
    const enableRes = await request(app)
      .post('/api/auth/2fa/enable')
      .set('Authorization', `Bearer ${ctx.tokens.employe}`)
      .send({ code });

    expect(enableRes.status).toBe(200);
    expect(enableRes.body.message).toMatch(/activé/i);

    // 4. Vérifier que totp_enabled=true et le secret est toujours chiffré
    const user = await Utilisateur.findByPk(ctx.employe.id);
    expect(user.totp_enabled).toBe(true);
    expect(user.totp_secret).toContain(':');
  });

  it('enable2FA refuse un code invalide', async () => {
    // Setup frais pour le manager
    await request(app)
      .get('/api/auth/2fa/setup')
      .set('Authorization', `Bearer ${ctx.tokens.manager}`);

    const res = await request(app)
      .post('/api/auth/2fa/enable')
      .set('Authorization', `Bearer ${ctx.tokens.manager}`)
      .send({ code: '000000' });

    expect(res.status).toBe(400);
  });

  it('enable2FA refuse un code rejoué (anti-replay)', async () => {
    // Setup frais pour l'admin
    const setupRes = await request(app)
      .get('/api/auth/2fa/setup')
      .set('Authorization', `Bearer ${ctx.tokens.admin}`);

    expect(setupRes.status).toBe(200);
    const { secret } = setupRes.body;
    const code = speakeasy.totp({ secret, encoding: 'base32' });

    // Premier appel — doit réussir
    const first = await request(app)
      .post('/api/auth/2fa/enable')
      .set('Authorization', `Bearer ${ctx.tokens.admin}`)
      .send({ code });

    expect(first.status).toBe(200);

    // Deuxième appel avec le même code — doit être rejeté
    const second = await request(app)
      .post('/api/auth/2fa/enable')
      .set('Authorization', `Bearer ${ctx.tokens.admin}`)
      .send({ code });

    expect(second.status).toBe(401);
    expect(second.body.message).toMatch(/déjà utilisé/i);
  });
});
