'use strict';
/**
 * logoutSignatureVerification.test.js — Fix #63
 *
 * PROBLÈME :
 *   logout() utilisait jwt.decode() (sans vérification de signature) pour extraire
 *   l'id utilisateur du refresh token cookie et invalider son hash en DB.
 *   Un attaquant pouvait forger un token avec n'importe quel id et déconnecter
 *   de force n'importe quel utilisateur (DoS ciblé).
 *
 * CORRECTION :
 *   jwt.verify() avec { ignoreExpiration: true } :
 *   - Vérifie la signature → rejette les tokens forgés (401).
 *   - Accepte les tokens expirés → le logout reste possible post-expiration.
 *
 * TESTS :
 *   A — token valide      → 200, refresh_token_hash effacé en DB
 *   B — token expiré      → 200, refresh_token_hash effacé (logout toujours possible)
 *   C — signature invalide → 401, refresh_token_hash NON touché
 */

const request = require('supertest');
const jwt     = require('jsonwebtoken');
const app     = require('../src/index');
const { seed } = require('./helpers/seed');
const { Utilisateur } = require('../src/models');

const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET;

let ctx;

beforeAll(async () => {
  ctx = await seed();
});

afterAll(async () => {
  await ctx.cleanup();
});

// Helper : crée un refresh token signé avec le bon secret
function makeRefreshToken(userId, options = {}) {
  return jwt.sign(
    { id: userId, type: 'refresh' },
    REFRESH_SECRET,
    options
  );
}

// Helper : pose le refresh_token_hash sur un utilisateur
async function setRefreshHash(userId, token) {
  const { hashRefreshToken } = require('../src/services/authService');
  await Utilisateur.update(
    { refresh_token_hash: hashRefreshToken(token) },
    { where: { id: userId } }
  );
}

// Helper : vérifie si le hash est null en DB
async function getRefreshHash(userId) {
  const u = await Utilisateur.findByPk(userId, { attributes: ['refresh_token_hash'] });
  return u?.refresh_token_hash;
}

// ─────────────────────────────────────────────────────────────────────────────
// A — Token valide → 200 + hash effacé
// ─────────────────────────────────────────────────────────────────────────────
describe('Fix #63 A — logout avec token valide → 200 + DB nettoyée', () => {
  it('efface le refresh_token_hash et répond 200', async () => {
    const token = makeRefreshToken(ctx.admin.id, { expiresIn: '7d' });
    await setRefreshHash(ctx.admin.id, token);

    const res = await request(app)
      .post('/api/auth/logout')
      .set('Cookie', `refreshToken=${token}`);

    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/déconnexion/i);
    expect(await getRefreshHash(ctx.admin.id)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B — Token expiré (signature valide) → 200 + hash effacé
//     Le logout doit fonctionner même après expiration du refresh token.
// ─────────────────────────────────────────────────────────────────────────────
describe('Fix #63 B — logout avec token expiré (bonne signature) → 200', () => {
  it('ignoreExpiration accepte le token expiré et efface le hash', async () => {
    // expiresIn: 0 → token déjà expiré à l'émission
    const expiredToken = makeRefreshToken(ctx.admin.id, { expiresIn: 0 });
    await setRefreshHash(ctx.admin.id, expiredToken);

    const res = await request(app)
      .post('/api/auth/logout')
      .set('Cookie', `refreshToken=${expiredToken}`);

    expect(res.status).toBe(200);
    expect(await getRefreshHash(ctx.admin.id)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C — Token à signature invalide → 401, hash NON touché
//     Un attaquant ne peut pas invalider le token d'un autre utilisateur.
// ─────────────────────────────────────────────────────────────────────────────
describe('Fix #63 C — logout avec signature invalide → 401 + DB intacte', () => {
  it('rejette le token forgé et ne touche pas la DB', async () => {
    // Pose un hash légitime en DB pour la victime
    const realToken = makeRefreshToken(ctx.manager.id, { expiresIn: '7d' });
    await setRefreshHash(ctx.manager.id, realToken);

    // Attaquant forge un token avec le bon id mais un mauvais secret
    const forgedToken = jwt.sign(
      { id: ctx.manager.id, type: 'refresh' },
      'mauvais-secret-forge'
    );

    const res = await request(app)
      .post('/api/auth/logout')
      .set('Cookie', `refreshToken=${forgedToken}`);

    expect(res.status).toBe(401);
    // Le hash de la victime est intact — elle est toujours connectée
    expect(await getRefreshHash(ctx.manager.id)).not.toBeNull();
  });
});
