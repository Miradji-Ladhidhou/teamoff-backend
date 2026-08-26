'use strict';
/**
 * auditAuthEvents.test.js
 *
 * Vérifie que LOGIN_FAILED et PASSWORD_RESET_REQUEST créent bien
 * un enregistrement en DB.
 *
 * AVANT fix : logAudit retourne silencieusement si entreprise_id est null
 *             → aucun log créé → FAIL
 * APRÈS fix  : logs créés même avec entreprise_id null (email inconnu)
 *              ou résolu depuis l'email (email connu) → PASS
 */

const { AuditLog, Entreprise, Utilisateur } = require('../src/models');
const { auditAuth } = require('../src/services/auditHelper');

const mockReq = { ip: '10.0.0.1', get: () => 'TestAgent/1.0' };

let entreprise, utilisateur;
const KNOWN_EMAIL = `known.audit.${Date.now()}@test.local`;
const UNKNOWN_EMAIL = `no-such-user.${Date.now()}@test.local`;

beforeAll(async () => {
  entreprise = await Entreprise.create({
    nom: 'AuditAuthTest-' + Date.now(),
    politique_conges: {},
    parametres: {},
  });
  utilisateur = await Utilisateur.create({
    prenom: 'Known', nom: 'User',
    email: KNOWN_EMAIL,
    role: 'employe',
    password_hash: 'hash',
    statut: 'actif',
    entreprise_id: entreprise.id,
  });
});

afterAll(async () => {
  // Supprimer les logs créés par les tests
  await AuditLog.destroy({ where: { action: ['LOGIN_FAILED', 'PASSWORD_RESET_REQUEST'] } }).catch(() => {});
  if (utilisateur) await Utilisateur.destroy({ where: { id: utilisateur.id } }).catch(() => {});
  if (entreprise)  await Entreprise.destroy({ where: { id: entreprise.id } }).catch(() => {});
});

describe('auditAuth.loginFailed', () => {
  it('crée un log LOGIN_FAILED pour un email inconnu (entreprise_id null)', async () => {
    const before = Date.now();
    await auditAuth.loginFailed(UNKNOWN_EMAIL, mockReq);

    const log = await AuditLog.findOne({
      where: { action: 'LOGIN_FAILED' },
      order: [['created_at', 'DESC']],
    });

    expect(log).not.toBeNull();
    expect(log.action).toBe('LOGIN_FAILED');
    expect(log.metadata?.email).toBe(UNKNOWN_EMAIL);
    expect(log.ip_address).toBe('10.0.0.1');
    expect(log.entreprise_id).toBeNull();           // email inconnu → null
    expect(new Date(log.created_at).getTime()).toBeGreaterThanOrEqual(before);
  });

  it('crée un log LOGIN_FAILED avec entreprise_id résolu pour un email connu', async () => {
    await auditAuth.loginFailed(KNOWN_EMAIL, mockReq);

    const log = await AuditLog.findOne({
      where: { action: 'LOGIN_FAILED' },
      order: [['created_at', 'DESC']],
    });

    expect(log).not.toBeNull();
    expect(log.metadata?.email).toBe(KNOWN_EMAIL);
    expect(log.entreprise_id).toBe(entreprise.id);  // email connu → entreprise_id résolu
  });
});

describe('auditAuth.passwordResetRequest', () => {
  it('crée un log PASSWORD_RESET_REQUEST pour un email inconnu', async () => {
    await auditAuth.passwordResetRequest(UNKNOWN_EMAIL, mockReq);

    const log = await AuditLog.findOne({
      where: { action: 'PASSWORD_RESET_REQUEST' },
      order: [['created_at', 'DESC']],
    });

    expect(log).not.toBeNull();
    expect(log.action).toBe('PASSWORD_RESET_REQUEST');
    expect(log.metadata?.email).toBe(UNKNOWN_EMAIL);
    expect(log.entreprise_id).toBeNull();
  });

  it('crée un log PASSWORD_RESET_REQUEST avec entreprise_id résolu pour un email connu', async () => {
    await auditAuth.passwordResetRequest(KNOWN_EMAIL, mockReq);

    const log = await AuditLog.findOne({
      where: { action: 'PASSWORD_RESET_REQUEST' },
      order: [['created_at', 'DESC']],
    });

    expect(log).not.toBeNull();
    expect(log.metadata?.email).toBe(KNOWN_EMAIL);
    expect(log.entreprise_id).toBe(entreprise.id);
  });
});
