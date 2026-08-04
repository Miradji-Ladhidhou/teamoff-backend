'use strict';
/**
 * twoFactorAudit.test.js — Fix #25
 *
 * Vérifie que chacune des trois actions 2FA crée bien un log d'audit en DB :
 *  - enable2FA  → TWO_FACTOR_ENABLED
 *  - verify2FA  → TWO_FACTOR_VERIFIED
 *  - disable2FA → TWO_FACTOR_DISABLED
 */

const request  = require('supertest');
const speakeasy = require('speakeasy');
const bcrypt   = require('bcrypt');
const app      = require('../src/index');
const { Utilisateur, Entreprise, AuditLog } = require('../src/models');
const { generateToken } = require('./helpers/auth');
const { decryptTotpSecret } = require('../src/utils/totpCrypto');

const GOOD_PASSWORD = 'Audit2FA1234!';

let entreprise;
let user;
let token;         // JWT de session pour les appels authentifiés
let plaintextSecret; // secret TOTP en clair pour générer des codes valides

beforeAll(async () => {
  entreprise = await Entreprise.create({
    nom: '2FA Audit Corp',
    politique_conges: {},
    parametres: {},
    statut: 'active',
  });

  user = await Utilisateur.create({
    entreprise_id: entreprise.id,
    prenom: 'Audit',
    nom:    '2FA',
    email:  `audit2fa.${Date.now()}@test.internal`,
    role:   'employe',
    password_hash: await bcrypt.hash(GOOD_PASSWORD, 10),
    statut: 'actif',
  });

  token = generateToken(user);
});

afterAll(async () => {
  await AuditLog.destroy({ where: { entreprise_id: entreprise.id } });
  await Utilisateur.destroy({ where: { id: user.id } });
  await Entreprise.destroy({ where: { id: entreprise.id } });
});

// ---------------------------------------------------------------------------
describe('enable2FA → log TWO_FACTOR_ENABLED', () => {
  it('crée un log TWO_FACTOR_ENABLED après activation réussie', async () => {
    // Setup : génère et stocke le secret
    const setupRes = await request(app)
      .get('/api/auth/2fa/setup')
      .set('Authorization', `Bearer ${token}`);
    expect(setupRes.status).toBe(200);
    plaintextSecret = setupRes.body.secret;

    // Générer un code TOTP valide
    const code = speakeasy.totp({ secret: plaintextSecret, encoding: 'base32' });

    const before = await AuditLog.count({
      where: { action: 'TWO_FACTOR_ENABLED', entity_id: user.id },
    });

    const res = await request(app)
      .post('/api/auth/2fa/enable')
      .set('Authorization', `Bearer ${token}`)
      .send({ code });

    expect(res.status).toBe(200);

    // Attendre l'écriture asynchrone du log (fire-and-forget)
    await new Promise((r) => setTimeout(r, 100));

    const after = await AuditLog.count({
      where: { action: 'TWO_FACTOR_ENABLED', entity_id: user.id },
    });
    expect(after).toBe(before + 1);
  });

  it('le log TWO_FACTOR_ENABLED a les bons champs', async () => {
    const log = await AuditLog.findOne({
      where: { action: 'TWO_FACTOR_ENABLED', entity_id: user.id },
      order: [['created_at', 'DESC']],
    });
    expect(log).not.toBeNull();
    expect(log.entity).toBe('utilisateur');
    expect(log.user_id).toBe(user.id);
    expect(log.entreprise_id).toBe(entreprise.id);
  });
});

// ---------------------------------------------------------------------------
describe('verify2FA → log TWO_FACTOR_VERIFIED', () => {
  it('crée un log TWO_FACTOR_VERIFIED après vérification 2FA réussie', async () => {
    // Récupérer le secret chiffré et le déchiffrer (enable2FA a peut-être écrasé le secret)
    const freshUser = await Utilisateur.findByPk(user.id);
    const secret = decryptTotpSecret(freshUser.totp_secret);

    // Réinitialiser l'anti-replay pour éviter le rejet du code
    await Utilisateur.update(
      { totp_used_at: null, totp_used_token: null },
      { where: { id: user.id } }
    );

    // Login → pending_token
    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ email: user.email, password: GOOD_PASSWORD });
    expect(loginRes.status).toBe(200);
    expect(loginRes.body.requires2fa).toBe(true);
    const pendingToken = loginRes.body.pending_token;

    const code = speakeasy.totp({ secret, encoding: 'base32' });

    const before = await AuditLog.count({
      where: { action: 'TWO_FACTOR_VERIFIED', entity_id: user.id },
    });

    const res = await request(app)
      .post('/api/auth/2fa/verify')
      .send({ pending_token: pendingToken, code });
    expect(res.status).toBe(200);

    await new Promise((r) => setTimeout(r, 100));

    const after = await AuditLog.count({
      where: { action: 'TWO_FACTOR_VERIFIED', entity_id: user.id },
    });
    expect(after).toBe(before + 1);
  });

  it('le log TWO_FACTOR_VERIFIED a les bons champs', async () => {
    const log = await AuditLog.findOne({
      where: { action: 'TWO_FACTOR_VERIFIED', entity_id: user.id },
      order: [['created_at', 'DESC']],
    });
    expect(log).not.toBeNull();
    expect(log.entity).toBe('utilisateur');
    expect(log.user_id).toBe(user.id);
    expect(log.entreprise_id).toBe(entreprise.id);
  });
});

// ---------------------------------------------------------------------------
describe('disable2FA → log TWO_FACTOR_DISABLED', () => {
  it('crée un log TWO_FACTOR_DISABLED après désactivation réussie', async () => {
    const before = await AuditLog.count({
      where: { action: 'TWO_FACTOR_DISABLED', entity_id: user.id },
    });

    const res = await request(app)
      .post('/api/auth/2fa/disable')
      .set('Authorization', `Bearer ${token}`)
      .send({ password: GOOD_PASSWORD });
    expect(res.status).toBe(200);

    await new Promise((r) => setTimeout(r, 100));

    const after = await AuditLog.count({
      where: { action: 'TWO_FACTOR_DISABLED', entity_id: user.id },
    });
    expect(after).toBe(before + 1);
  });

  it('le log TWO_FACTOR_DISABLED a les bons champs', async () => {
    const log = await AuditLog.findOne({
      where: { action: 'TWO_FACTOR_DISABLED', entity_id: user.id },
      order: [['created_at', 'DESC']],
    });
    expect(log).not.toBeNull();
    expect(log.entity).toBe('utilisateur');
    expect(log.user_id).toBe(user.id);
    expect(log.entreprise_id).toBe(entreprise.id);
  });
});
