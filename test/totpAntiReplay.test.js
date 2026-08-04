'use strict';
/**
 * totpAntiReplay.test.js
 *
 * BILAN #23 — verify2FA ne protège pas contre le rejeu de code TOTP.
 * Un code valide peut être présenté deux fois dans la même fenêtre (~90 s).
 *
 * AVANT fix : les deux appels retournent 200 (bug).
 * APRÈS fix  : le second appel retourne 401 "Code TOTP déjà utilisé".
 */

const request   = require('supertest');
const speakeasy = require('speakeasy');
const jwt       = require('jsonwebtoken');
const app       = require('../src/index');
const { seed, TEST_PASSWORD } = require('./helpers/seed');
const { Utilisateur } = require('../src/models');
const { encryptTotpSecret, decryptTotpSecret } = require('../src/utils/totpCrypto');

let ctx;
let plaintextSecret;
let pendingToken;

beforeAll(async () => {
  ctx = await seed();

  // 1. Générer et activer un secret TOTP pour l'employé de test
  const secret = speakeasy.generateSecret({ length: 20 });
  plaintextSecret = secret.base32;

  await Utilisateur.update(
    {
      totp_secret: encryptTotpSecret(plaintextSecret),
      totp_enabled: true,
      // Réinitialiser l'anti-replay pour que les tests partent d'un état propre
      totp_used_at: null,
      totp_used_token: null,
    },
    { where: { id: ctx.employe.id } }
  );

  // 2. Obtenir un pending_token (simuler un login)
  const loginRes = await request(app)
    .post('/api/auth/login')
    .send({ email: ctx.employe.email, password: TEST_PASSWORD });

  pendingToken = loginRes.body.pending_token;
});

afterAll(async () => {
  // Désactiver le 2FA sur l'employé de test
  await Utilisateur.update(
    { totp_secret: null, totp_enabled: false, totp_used_at: null, totp_used_token: null },
    { where: { id: ctx.employe.id } }
  );
  await ctx.cleanup();
});

describe('verify2FA — protection anti-replay', () => {
  it('premier appel avec un code valide : 200 (authentification réussie)', async () => {
    if (!pendingToken) return;

    const code = speakeasy.totp({ secret: plaintextSecret, encoding: 'base32' });

    const res = await request(app)
      .post('/api/auth/2fa/verify')
      .send({ pending_token: pendingToken, code });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('token');
  });

  it('second appel avec le même code dans la même fenêtre : 401 (AVANT fix : 200 — bug)', async () => {
    if (!pendingToken) return;

    // On réutilise EXACTEMENT le même code que la vérification précédente.
    // Il reste dans la fenêtre TOTP (< 30 s se sont écoulées).
    const code = speakeasy.totp({ secret: plaintextSecret, encoding: 'base32' });

    // Premier appel (peut être déjà fait dans le test précédent, mais on en fait un ici
    // aussi pour s'assurer que l'état est correct même si les tests tournent dans l'ordre)
    await request(app)
      .post('/api/auth/2fa/verify')
      .send({ pending_token: pendingToken, code });

    // Second appel avec le MÊME code
    const res = await request(app)
      .post('/api/auth/2fa/verify')
      .send({ pending_token: pendingToken, code });

    // AVANT fix : res.status = 200 (rejoué avec succès — bug)
    // APRÈS fix  : res.status = 401 (code déjà consommé)
    expect(res.status).toBe(401);
    expect(res.body.message).toMatch(/déjà utilisé|replay/i);
  });

  it('nouveau code TOTP généré après le premier : 200 (pas de faux positif)', async () => {
    if (!pendingToken) return;

    // Attendre que la fenêtre change est peu pratique en test ; on réinitialise
    // directement totp_used_at pour simuler que la fenêtre précédente est expirée.
    await Utilisateur.update(
      { totp_used_at: new Date(Date.now() - 100_000) }, // 100 s dans le passé > 90 s
      { where: { id: ctx.employe.id } }
    );

    const code = speakeasy.totp({ secret: plaintextSecret, encoding: 'base32' });

    // Il faut aussi un nouveau pending_token car le précédent a émis un refresh token
    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ email: ctx.employe.email, password: TEST_PASSWORD });
    const newPendingToken = loginRes.body.pending_token;
    if (!newPendingToken) return;

    const res = await request(app)
      .post('/api/auth/2fa/verify')
      .send({ pending_token: newPendingToken, code });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('token');
  });
});
