'use strict';
/**
 * notificationOwnership.test.js — Fix #74
 *
 * PROBLÈME :
 *   marquerCommeLue(notificationId) dans notificationService.js n'acceptait pas
 *   de paramètre utilisateurId et ne vérifiait pas l'ownership : n'importe quel
 *   appelant connaissant l'UUID d'une notification pouvait la marquer comme lue.
 *   Le contrôleur avait son propre check inline mais n'appelait pas le service,
 *   laissant la fonction service exportée sans protection.
 *
 * CORRECTION :
 *   - Service : ajout de `utilisateurId` + rejet 403 si ownership incorrecte.
 *   - Contrôleur : délègue désormais au service (supprime la duplication inline).
 *
 * TESTS (au niveau service, sans HTTP) :
 *   A — marquer la notification du bon utilisateur → réussite
 *   B — marquer la notification d'un autre utilisateur → rejet 403
 *   C — notification inexistante → rejet 404
 */

const { seed } = require('./helpers/seed');
const notificationService = require('../src/services/notificationService');
const { Notification } = require('../src/models');

let ctx;
let notifEmploye;

beforeAll(async () => {
  ctx = await seed();

  notifEmploye = await Notification.create({
    entreprise_id: ctx.entreprise.id,
    utilisateur_id: ctx.employe.id,
    type: 'test',
    message: 'notification de test Fix #74',
    lu: false,
  });
});

afterAll(async () => {
  await notifEmploye?.destroy();
  await ctx.cleanup();
});

// ─────────────────────────────────────────────────────────────────────────────
// A — le propriétaire peut marquer sa notification comme lue
// ─────────────────────────────────────────────────────────────────────────────
describe('Fix #74 A — propriétaire → succès', () => {
  it('marquerCommeLue avec le bon utilisateurId → lu = true', async () => {
    const result = await notificationService.marquerCommeLue(notifEmploye.id, ctx.employe.id);
    expect(result.lu).toBe(true);
    expect(result.id).toBe(notifEmploye.id);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B — un autre utilisateur ne peut pas marquer la notification comme lue
// ─────────────────────────────────────────────────────────────────────────────
describe('Fix #74 B — utilisateur tiers → rejet 403', () => {
  it('marquerCommeLue avec l\'id d\'un autre utilisateur → status 403', async () => {
    await expect(
      notificationService.marquerCommeLue(notifEmploye.id, ctx.manager.id)
    ).rejects.toMatchObject({ status: 403, message: 'Accès refusé' });
  });

  it('l\'admin ne peut pas non plus marquer la notification d\'un autre', async () => {
    await expect(
      notificationService.marquerCommeLue(notifEmploye.id, ctx.admin.id)
    ).rejects.toMatchObject({ status: 403 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C — notification inexistante → rejet 404
// ─────────────────────────────────────────────────────────────────────────────
describe('Fix #74 C — notification inexistante → rejet 404', () => {
  it('UUID valide mais inconnu → status 404', async () => {
    const unknownId = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
    await expect(
      notificationService.marquerCommeLue(unknownId, ctx.employe.id)
    ).rejects.toMatchObject({ status: 404, message: 'Notification introuvable' });
  });
});
