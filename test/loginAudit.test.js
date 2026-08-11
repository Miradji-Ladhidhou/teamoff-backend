'use strict';
/**
 * loginAudit.test.js
 *
 * Vérifie que les événements LOGIN_FAILED et PASSWORD_RESET_REQUEST sont
 * bien écrits dans la table audit_logs, avec les champs attendus et sans
 * aucun secret (mot de passe, hash) dans les métadonnées.
 */

const request  = require('supertest');
const app      = require('../src/index');
const { seed } = require('./helpers/seed');
const { AuditLog } = require('../src/models');

let ctx;

beforeAll(async () => {
  ctx = await seed();
  // Purger les audit_logs existants de l'entreprise de test avant chaque suite
  await AuditLog.destroy({ where: {}, truncate: false });
});

afterAll(async () => {
  await ctx.cleanup();
});

// ---------------------------------------------------------------------------
// LOGIN_FAILED
// ---------------------------------------------------------------------------
describe('Audit — LOGIN_FAILED', () => {
  it('un login avec mauvais mot de passe crée une entrée LOGIN_FAILED dans audit_logs', async () => {
    const before = Date.now();

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: ctx.employe.email, password: 'MauvaisMotDePasse!' });

    expect(res.status).toBe(401);

    // Attendre que l'écriture asynchrone soit commitée
    await new Promise(r => setTimeout(r, 200));

    const log = await AuditLog.findOne({
      where: { action: 'LOGIN_FAILED' },
      order: [['created_at', 'DESC']],
    });

    expect(log).not.toBeNull();
    expect(log.action).toBe('LOGIN_FAILED');
    expect(log.entity).toBe('auth');

    // L'email ciblé doit être présent dans les métadonnées
    expect(log.metadata?.email).toBe(ctx.employe.email);

    // Le log doit avoir été créé après le début du test
    expect(new Date(log.created_at).getTime()).toBeGreaterThanOrEqual(before);

    // Aucun secret dans les métadonnées
    expect(log.metadata?.password).toBeUndefined();
    expect(log.metadata?.password_hash).toBeUndefined();
    expect(log.metadata?.mot_de_passe).toBeUndefined();

    // user_id doit être null (pas encore authentifié)
    expect(log.user_id).toBeNull();
  });

  it('un login avec email inconnu crée aussi une entrée LOGIN_FAILED', async () => {
    await AuditLog.destroy({ where: { action: 'LOGIN_FAILED' } });

    await request(app)
      .post('/api/auth/login')
      .send({ email: 'inconnu@inconnu.test', password: 'n\'importe' });

    await new Promise(r => setTimeout(r, 200));

    const log = await AuditLog.findOne({
      where: { action: 'LOGIN_FAILED' },
      order: [['created_at', 'DESC']],
    });

    expect(log).not.toBeNull();
    expect(log.metadata?.email).toBe('inconnu@inconnu.test');
    // entreprise_id doit être null (email inconnu, impossible à résoudre)
    expect(log.entreprise_id).toBeNull();
    expect(log.user_id).toBeNull();
  });

  it('le log LOGIN_FAILED pour un email connu contient un entreprise_id', async () => {
    await AuditLog.destroy({ where: { action: 'LOGIN_FAILED' } });

    await request(app)
      .post('/api/auth/login')
      .send({ email: ctx.employe.email, password: 'MauvaisMotDePasse!' });

    await new Promise(r => setTimeout(r, 200));

    const log = await AuditLog.findOne({
      where: { action: 'LOGIN_FAILED' },
      order: [['created_at', 'DESC']],
    });

    expect(log).not.toBeNull();
    // L'entreprise est résolue depuis l'email même sans authentification
    expect(log.entreprise_id).toBe(ctx.employe.entreprise_id);
  });

  it('un login réussi ne crée PAS d\'entrée LOGIN_FAILED', async () => {
    await AuditLog.destroy({ where: { action: 'LOGIN_FAILED' } });

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: ctx.employe.email, password: 'Test1234!' });

    // Le login peut retourner 200 ou 307 (2FA pending), les deux sont des succès
    expect([200, 307]).toContain(res.status);

    await new Promise(r => setTimeout(r, 200));

    const log = await AuditLog.findOne({ where: { action: 'LOGIN_FAILED' } });
    expect(log).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// PASSWORD_RESET_REQUEST
// ---------------------------------------------------------------------------
describe('Audit — PASSWORD_RESET_REQUEST', () => {
  beforeEach(async () => {
    await AuditLog.destroy({ where: { action: 'PASSWORD_RESET_REQUEST' } });
  });

  it('une demande de reset avec email connu crée une entrée PASSWORD_RESET_REQUEST', async () => {
    const before = Date.now();

    const res = await request(app)
      .post('/api/auth/forgot-password')
      .send({ email: ctx.employe.email });

    // Réponse générique toujours 200 (anti-énumération)
    expect(res.status).toBe(200);

    await new Promise(r => setTimeout(r, 200));

    const log = await AuditLog.findOne({
      where: { action: 'PASSWORD_RESET_REQUEST' },
      order: [['created_at', 'DESC']],
    });

    expect(log).not.toBeNull();
    expect(log.action).toBe('PASSWORD_RESET_REQUEST');
    expect(log.entity).toBe('auth');
    expect(log.metadata?.email).toBe(ctx.employe.email);
    expect(new Date(log.created_at).getTime()).toBeGreaterThanOrEqual(before);

    // Aucun secret dans les métadonnées
    expect(log.metadata?.token).toBeUndefined();
    expect(log.metadata?.password).toBeUndefined();
    expect(log.metadata?.reset_token).toBeUndefined();

    expect(log.user_id).toBeNull();
    expect(log.entreprise_id).toBe(ctx.employe.entreprise_id);
  });

  it('une demande de reset avec email inconnu crée aussi une entrée PASSWORD_RESET_REQUEST', async () => {
    // Important : même comportement pour ne pas révéler si l'email existe
    const res = await request(app)
      .post('/api/auth/forgot-password')
      .send({ email: 'fantome@inconnu.test' });

    expect(res.status).toBe(200);

    await new Promise(r => setTimeout(r, 200));

    const log = await AuditLog.findOne({
      where: { action: 'PASSWORD_RESET_REQUEST' },
      order: [['created_at', 'DESC']],
    });

    expect(log).not.toBeNull();
    expect(log.metadata?.email).toBe('fantome@inconnu.test');
    expect(log.entreprise_id).toBeNull();
    expect(log.user_id).toBeNull();
  });
});
