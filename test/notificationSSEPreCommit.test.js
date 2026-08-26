'use strict';
/**
 * notificationSSEPreCommit.test.js
 *
 * BILAN #21 — creerNotification() appelle sseManager.sendToUser() avant que la
 * transaction ne soit committée. Si la transaction est ensuite rollbackée, l'utilisateur
 * a reçu une notification SSE pour un événement qui n'a pas eu lieu.
 *
 * AVANT fix : SSE envoyé immédiatement après Notification.create() dans la transaction.
 * APRÈS fix  : SSE enregistré dans transaction.afterCommit() → ne part que si commit réussit.
 */

const { sequelize, Entreprise, Utilisateur } = require('../src/models');
const sseManager = require('../src/services/sseManager');
const { creerNotification } = require('../src/services/notificationService');

const suffix = String(Date.now()).slice(-6);
let ent, user;

beforeAll(async () => {
  ent = await Entreprise.create({
    nom: 'SSEPreCommit-' + suffix,
    politique_conges: { approval_workflow: 'admin_only' },
    parametres: {},
  });
  user = await Utilisateur.create({
    prenom: 'Sse', nom: 'Test',
    email: `sse.${suffix}@test.local`,
    role: 'employe', password_hash: 'hash', statut: 'actif',
    entreprise_id: ent.id,
  });
});

afterAll(async () => {
  await Utilisateur.destroy({ where: { id: user.id } }).catch(() => {});
  await Entreprise.destroy({ where: { id: ent.id } }).catch(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('creerNotification — SSE après commit seulement', () => {
  it('SSE NON envoyé si la transaction est rollbackée (AVANT fix : envoyé trop tôt)', async () => {
    let sseCalled = false;
    jest.spyOn(sseManager, 'sendToUser').mockImplementation(() => { sseCalled = true; });

    const t = await sequelize.transaction();
    try {
      await creerNotification({
        entreprise_id: ent.id,
        utilisateur_id: user.id,
        type: 'conge_demande',
        message: 'test sse pre-commit',
        transaction: t,
      });

      // Juste après creerNotification, avant commit :
      // AVANT fix : sseCalled = true  (bug — SSE part avant commit)
      // APRÈS fix  : sseCalled = false (correct — enregistré dans afterCommit)
      expect(sseCalled).toBe(false);

      await t.rollback();

      // Après rollback, le SSE ne doit JAMAIS partir
      expect(sseCalled).toBe(false);
    } catch (e) {
      await t.rollback().catch(() => {});
      throw e;
    }
  });

  it('SSE envoyé après un commit réussi', async () => {
    let sseCalled = false;
    jest.spyOn(sseManager, 'sendToUser').mockImplementation(() => { sseCalled = true; });

    const t = await sequelize.transaction();
    try {
      const notif = await creerNotification({
        entreprise_id: ent.id,
        utilisateur_id: user.id,
        type: 'conge_approuve',
        message: 'test sse post-commit',
        transaction: t,
      });

      // Avant commit : SSE pas encore envoyé
      expect(sseCalled).toBe(false);

      await t.commit();

      // Après commit : SSE doit être envoyé
      expect(sseCalled).toBe(true);

      // Cleanup
      await notif.destroy().catch(() => {});
    } catch (e) {
      await t.rollback().catch(() => {});
      throw e;
    }
  });

  it('SSE envoyé immédiatement sans transaction (chemin notifyUser)', async () => {
    let sseCalled = false;
    jest.spyOn(sseManager, 'sendToUser').mockImplementation(() => { sseCalled = true; });

    const notif = await creerNotification({
      entreprise_id: ent.id,
      utilisateur_id: user.id,
      type: 'conge_annule',
      message: 'test sse sans transaction',
      transaction: null,
    });

    // Sans transaction : SSE doit partir immédiatement
    expect(sseCalled).toBe(true);

    await notif.destroy().catch(() => {});
  });
});
