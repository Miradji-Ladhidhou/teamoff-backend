'use strict';
/**
 * auth.js — helpers d'authentification pour les tests.
 *
 * Génère de vrais tokens JWT signés avec JWT_SECRET (pas de mocks).
 * Les tokens sont valides pour un utilisateur récupéré depuis la DB.
 */

const jwt = require('jsonwebtoken');
const request = require('supertest');

/**
 * Génère un token JWT valide pour un utilisateur donné.
 * Utilise le même format que authService.generateAccessToken().
 */
function generateToken(user, expiresIn = '1h') {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET non défini dans les variables d\'environnement');

  return jwt.sign(
    {
      id: user.id,
      role: user.role,
      entreprise_id: user.entreprise_id,
    },
    secret,
    { expiresIn }
  );
}

/**
 * Génère un token expiré (utile pour tester le rejet de tokens périmés).
 */
function generateExpiredToken(user) {
  const secret = process.env.JWT_SECRET;
  return jwt.sign(
    { id: user.id, role: user.role, entreprise_id: user.entreprise_id },
    secret,
    { expiresIn: '-1s' } // déjà expiré
  );
}

/**
 * Appelle POST /api/auth/login et retourne le token d'accès.
 * Utilise les vraies credentials hashées dans la DB de test.
 */
async function loginAs(app, email, password) {
  const res = await request(app)
    .post('/api/auth/login')
    .send({ email, password });

  if (res.status !== 200) {
    throw new Error(
      `Login échoué pour ${email} — statut ${res.status}: ${JSON.stringify(res.body)}`
    );
  }

  return res.body.token || res.body.accessToken;
}

module.exports = { generateToken, generateExpiredToken, loginAs };
