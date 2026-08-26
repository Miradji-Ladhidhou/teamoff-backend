'use strict';
/**
 * exportPreviewLimitCap.test.js — Fix #52
 *
 * GET /api/exports/preview accepte ?limit sans borne supérieure.
 * ?limit=999999 envoie LIMIT 999999 à PostgreSQL → vecteur DoS.
 *
 * AVANT fix : limitedTo reflète la valeur brute envoyée (999999 ou "999999").
 * APRÈS fix  : limit est plafonné à 500 ; toute valeur supérieure est ramenée à 500.
 *
 * Cas testés :
 *   A) ?limit=999999 → limitedTo vaut 500 (plafonné)
 *   B) ?limit=10     → limitedTo vaut 10  (valeur légitime conservée)
 *   C) ?limit=0      → limitedTo vaut 50  (valeur invalide → défaut)
 *   D) limit absent  → limitedTo vaut 50  (défaut)
 */

const request = require('supertest');
const app = require('../src/index');
const { Entreprise, Utilisateur } = require('../src/models');
const { generateToken } = require('./helpers/auth');

const TS = Date.now();
let entreprise, admin, adminToken;

const MAX_PREVIEW = 500;
const DEFAULT_PREVIEW = 50;

beforeAll(async () => {
  entreprise = await Entreprise.create({
    nom: `LimitCap52_${TS}`,
    politique_conges: {},
    parametres: {},
    statut: 'active',
  });

  admin = await Utilisateur.create({
    prenom: 'Admin',
    nom: 'LimitCap',
    email: `admin.limitcap.52.${TS}@test.local`,
    role: 'admin_entreprise',
    password_hash: 'hash',
    statut: 'actif',
    entreprise_id: entreprise.id,
  });

  adminToken = generateToken(admin);
});

afterAll(async () => {
  if (admin)      await Utilisateur.destroy({ where: { id: admin.id } }).catch(() => {});
  if (entreprise) await Entreprise.destroy({ where: { id: entreprise.id } }).catch(() => {});
});

// ─────────────────────────────────────────────────────────────────────────────
// A) limit=999999 → plafonné à MAX_PREVIEW
// ─────────────────────────────────────────────────────────────────────────────

describe('Fix #52 A — limit=999999 est plafonné', () => {
  it(`limitedTo est au maximum ${MAX_PREVIEW} meme avec limit=999999`, async () => {
    const res = await request(app)
      .get('/api/exports/preview?type=conges&limit=999999')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(Number(res.body.limitedTo)).toBeLessThanOrEqual(MAX_PREVIEW);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B) limit=10 → valeur légitime conservée
// ─────────────────────────────────────────────────────────────────────────────

describe('Fix #52 B — limit=10 conservé (dans les bornes)', () => {
  it('limitedTo vaut 10 avec limit=10', async () => {
    const res = await request(app)
      .get('/api/exports/preview?type=conges&limit=10')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(Number(res.body.limitedTo)).toBe(10);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C) limit=0 → valeur invalide → défaut 50
// ─────────────────────────────────────────────────────────────────────────────

describe('Fix #52 C — limit=0 invalide → défaut', () => {
  it(`limitedTo vaut ${DEFAULT_PREVIEW} avec limit=0`, async () => {
    const res = await request(app)
      .get('/api/exports/preview?type=conges&limit=0')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(Number(res.body.limitedTo)).toBe(DEFAULT_PREVIEW);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D) limit absent → défaut 50
// ─────────────────────────────────────────────────────────────────────────────

describe('Fix #52 D — limit absent → défaut', () => {
  it(`limitedTo vaut ${DEFAULT_PREVIEW} sans parametre limit`, async () => {
    const res = await request(app)
      .get('/api/exports/preview?type=conges')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(Number(res.body.limitedTo)).toBe(DEFAULT_PREVIEW);
  });
});
