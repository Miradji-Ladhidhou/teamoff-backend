'use strict';
/**
 * servicePolicyNoticeTiers.test.js
 *
 * Vérifie que les champs de préavis par service
 * (notice_urgency_threshold, notice_urgent_days, notice_normal_days)
 * sont correctement persistés et restitués via :
 *   PUT /api/entreprises/:id/politique          (mise à jour globale)
 *   POST /api/entreprises/:id/services          (création de service)
 *   PUT  /api/entreprises/:id/services/:name    (mise à jour de service)
 *
 * AVANT fix : normalizeServicePolicy ne retournait pas ces trois champs
 *             → silencieusement strippés à chaque sauvegarde.
 * APRÈS fix  : les champs sont inclus dans la normalisation et persistés.
 *
 * Cas testés :
 *   A) PUT /politique avec service_policies contenant des tiers de préavis → persistés
 *   B) POST /services avec notice_urgency_threshold → persisté
 *   C) PUT /services/:name mise à jour des tiers → persistés
 *   D) Valeurs négatives normalisées à 0
 *   E) Champs absents → défaut à 0 (pas d'erreur 500)
 */

const request = require('supertest');
const app = require('../src/index');
const { Entreprise, Utilisateur } = require('../src/models');
const bcrypt = require('bcrypt');
const { generateToken } = require('./helpers/auth');

const suffix = String(Date.now()).slice(-6);
let entreprise, admin;

beforeAll(async () => {
  const hash = await bcrypt.hash('Password1!', 10);

  entreprise = await Entreprise.create({
    nom: `SvcNotice_${suffix}`,
    politique_conges: {
      approval_workflow: 'manager_admin',
      blocked_days: { exclude_weekends: false, exclude_holidays: false },
      service_policies: {},
      max_employees_on_leave: { by_service: {} },
    },
    parametres: {},
    statut: 'active',
  });

  admin = await Utilisateur.create({
    prenom: 'Admin', nom: `Notice${suffix}`,
    email: `admin.svcnotice.${suffix}@test.local`,
    role: 'admin_entreprise',
    password_hash: hash,
    statut: 'actif',
    entreprise_id: entreprise.id,
  });
});

afterAll(async () => {
  await Utilisateur.destroy({ where: { id: admin.id } }).catch(() => {});
  await Entreprise.destroy({ where: { id: entreprise.id } }).catch(() => {});
});

function putPolitique(token, payload) {
  return request(app)
    .put(`/api/entreprises/${entreprise.id}/politique`)
    .set('Authorization', `Bearer ${token}`)
    .send({ politique_conges: payload });
}

function postService(token, name, policy = {}) {
  return request(app)
    .post(`/api/entreprises/${entreprise.id}/services`)
    .set('Authorization', `Bearer ${token}`)
    .send({ name, policy });
}

function putService(token, name, body = {}) {
  return request(app)
    .put(`/api/entreprises/${entreprise.id}/services/${encodeURIComponent(name)}`)
    .set('Authorization', `Bearer ${token}`)
    .send(body);
}

function getServices(token) {
  return request(app)
    .get(`/api/entreprises/${entreprise.id}/services`)
    .set('Authorization', `Bearer ${token}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// A) PUT /politique — service_policies avec tiers de préavis
// ─────────────────────────────────────────────────────────────────────────────

describe('A — PUT /politique persiste les tiers de préavis service', () => {
  it('notice_urgency_threshold / notice_urgent_days / notice_normal_days sauvegardés', async () => {
    const token = generateToken(admin);

    const res = await putPolitique(token, {
      service_policies: {
        Marketing: {
          approval_workflow: 'manager_admin',
          notice_urgency_threshold: 3,
          notice_urgent_days: 2,
          notice_normal_days: 7,
          max_consecutive_days: 30,
          max_employees_on_leave: 0,
        },
      },
      max_employees_on_leave: { by_service: {} },
    });

    expect(res.status).toBe(200);
    const sp = res.body.politique_conges?.service_policies?.Marketing;
    expect(sp).toBeDefined();
    expect(sp.notice_urgency_threshold).toBe(3);
    expect(sp.notice_urgent_days).toBe(2);
    expect(sp.notice_normal_days).toBe(7);
  });

  it('les champs persistent après un second GET /politique', async () => {
    const token = generateToken(admin);
    const res = await request(app)
      .get(`/api/entreprises/${entreprise.id}/politique`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    const sp = res.body.politique_conges?.service_policies?.Marketing;
    expect(sp?.notice_urgency_threshold).toBe(3);
    expect(sp?.notice_urgent_days).toBe(2);
    expect(sp?.notice_normal_days).toBe(7);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B) POST /services — création avec tiers de préavis
// ─────────────────────────────────────────────────────────────────────────────

describe('B — POST /services persiste les tiers de préavis', () => {
  it('créer un service avec notice_urgency_threshold=5 → persisté', async () => {
    const token = generateToken(admin);

    const res = await postService(token, `RH_${suffix}`, {
      approval_workflow: 'manager_only',
      notice_urgency_threshold: 5,
      notice_urgent_days: 3,
      notice_normal_days: 10,
      max_consecutive_days: 20,
      max_employees_on_leave: 2,
    });

    expect(res.status).toBe(201);
    expect(res.body.item?.policy?.notice_urgency_threshold).toBe(5);
    expect(res.body.item?.policy?.notice_urgent_days).toBe(3);
    expect(res.body.item?.policy?.notice_normal_days).toBe(10);
  });

  it('le service créé est retourné par GET /services avec les bons tiers', async () => {
    const token = generateToken(admin);
    const res = await getServices(token);
    expect(res.status).toBe(200);

    const svc = res.body.items?.find((s) => s.name === `RH_${suffix}`);
    expect(svc).toBeDefined();
    expect(svc.policy?.notice_urgency_threshold).toBe(5);
    expect(svc.policy?.notice_urgent_days).toBe(3);
    expect(svc.policy?.notice_normal_days).toBe(10);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C) PUT /services/:name — mise à jour des tiers
// ─────────────────────────────────────────────────────────────────────────────

describe('C — PUT /services/:name met à jour les tiers de préavis', () => {
  it('modifier notice_urgency_threshold de 5 à 2 → persisté', async () => {
    const token = generateToken(admin);
    const svcName = `RH_${suffix}`;

    const res = await putService(token, svcName, {
      name: svcName,
      policy: {
        approval_workflow: 'manager_only',
        notice_urgency_threshold: 2,
        notice_urgent_days: 1,
        notice_normal_days: 5,
        max_consecutive_days: 20,
        max_employees_on_leave: 2,
      },
    });

    expect(res.status).toBe(200);
    expect(res.body.item?.policy?.notice_urgency_threshold).toBe(2);
    expect(res.body.item?.policy?.notice_urgent_days).toBe(1);
    expect(res.body.item?.policy?.notice_normal_days).toBe(5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D) Valeurs négatives normalisées à 0
// ─────────────────────────────────────────────────────────────────────────────

describe('D — valeurs négatives normalisées à 0', () => {
  it('notice_urgency_threshold=-3 → stocké 0', async () => {
    const token = generateToken(admin);
    const svcName = `SvcNeg_${suffix}`;

    const createRes = await postService(token, svcName, {
      notice_urgency_threshold: -3,
      notice_urgent_days: -1,
      notice_normal_days: -5,
    });
    expect(createRes.status).toBe(201);
    expect(createRes.body.item?.policy?.notice_urgency_threshold).toBe(0);
    expect(createRes.body.item?.policy?.notice_urgent_days).toBe(0);
    expect(createRes.body.item?.policy?.notice_normal_days).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E) Champs absents → défaut 0 (pas d'erreur 500)
// ─────────────────────────────────────────────────────────────────────────────

describe('E — champs absents → défaut 0 sans erreur', () => {
  it('créer un service sans champs notice → response 201 avec 0 par défaut', async () => {
    const token = generateToken(admin);
    const svcName = `SvcDefault_${suffix}`;

    const res = await postService(token, svcName, {
      approval_workflow: 'admin_only',
    });

    expect(res.status).toBe(201);
    expect(res.body.item?.policy?.notice_urgency_threshold).toBe(0);
    expect(res.body.item?.policy?.notice_urgent_days).toBe(0);
    expect(res.body.item?.policy?.notice_normal_days).toBe(0);
  });
});
