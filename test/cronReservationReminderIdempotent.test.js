'use strict';
/**
 * cronReservationReminderIdempotent.test.js — Fix #61
 *
 * PROBLÈME :
 *   runReservationReminders() (J-30/J-7) n'était pas idempotent : deux instances
 *   simultanées (PM2 cluster, K8s) trouvaient les mêmes conges et envoyaient
 *   chacune leurs emails → double envoi pour chaque admin/manager.
 *
 * CORRECTION :
 *   Verrou atomique par flag DB (reminder_j30_sent_at / reminder_j7_sent_at).
 *   Seule l'instance qui pose le flag (UPDATE WHERE IS NULL → 1 row) envoie.
 *   Les autres obtiennent rowsClaimed = 0 et passent au suivant.
 *
 * TESTS :
 *   A — deux exécutions concurrentes (Promise.all) → emails envoyés une seule fois
 *   B — troisième exécution → aucun envoi supplémentaire (flag déjà posé)
 *   C — cohérence #26 : runPendingLeaveReminders reste borné par fenêtre glissante
 */

jest.mock('../src/services/emailService');
const emailService = require('../src/services/emailService');

const dayjs = require('dayjs');
const { seed } = require('./helpers/seed');
const { Conge } = require('../src/models');
const { runReservationReminders, runPendingLeaveReminders } = require('../src/cron/emailCron');

let ctx, congeJ30, congeJ7;

beforeAll(async () => {
  ctx = await seed();

  const dateJ30 = dayjs().add(30, 'day').format('YYYY-MM-DD');
  const dateJ7  = dayjs().add(7,  'day').format('YYYY-MM-DD');

  [congeJ30, congeJ7] = await Promise.all([
    Conge.create({
      entreprise_id:  ctx.entreprise.id,
      utilisateur_id: ctx.employe.id,
      conge_type_id:  ctx.congeType.id,
      date_debut:     dateJ30,
      date_fin:       dateJ30,
      statut:         'reserve',
      jours_calcules: 1,
    }),
    Conge.create({
      entreprise_id:  ctx.entreprise.id,
      utilisateur_id: ctx.employe.id,
      conge_type_id:  ctx.congeType.id,
      date_debut:     dateJ7,
      date_fin:       dateJ7,
      statut:         'reserve',
      jours_calcules: 1,
    }),
  ]);
});

afterAll(async () => {
  await Conge.destroy({ where: { entreprise_id: ctx.entreprise.id } });
  await ctx.cleanup();
});

beforeEach(() => {
  emailService.sendEmail = jest.fn().mockResolvedValue(undefined);
});

// ─────────────────────────────────────────────────────────────────────────────
// A — Deux runs concurrents → emails envoyés exactement une fois
//     Avant fix : 2 runs × N admins = 2N appels.
//     Après fix  : 1 seul run s'approprie le flag → N appels.
// ─────────────────────────────────────────────────────────────────────────────
describe('Fix #61 A — deux exécutions concurrentes → un seul envoi', () => {
  it('Promise.all de deux runReservationReminders n\'envoie pas en double', async () => {
    // Simule deux instances démarrant simultanément
    await Promise.all([
      runReservationReminders(),
      runReservationReminders(),
    ]);

    // Le seed contient 1 admin_entreprise + 1 manager = 2 destinataires
    // Pour 2 conges (J-30 et J-7) : 2 × 2 = 4 appels attendus au total.
    // Sans fix : 8 appels (double envoi par instance).
    const callCount = emailService.sendEmail.mock.calls.length;
    expect(callCount).toBe(4); // 2 conges × 2 destinataires, jamais 8

    // Les flags doivent être posés
    await congeJ30.reload();
    await congeJ7.reload();
    expect(congeJ30.reminder_j30_sent_at).not.toBeNull();
    expect(congeJ7.reminder_j7_sent_at).not.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B — Troisième exécution → aucun envoi (flags déjà posés)
// ─────────────────────────────────────────────────────────────────────────────
describe('Fix #61 B — troisième exécution → zéro envoi', () => {
  it('runReservationReminders ne renvoie pas quand les flags sont posés', async () => {
    await runReservationReminders();
    expect(emailService.sendEmail).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C — Cohérence #26 : runPendingLeaveReminders est borné par fenêtre glissante
//     Un conge en attente qui ne tombe pas dans une fenêtre n'est pas relancé.
// ─────────────────────────────────────────────────────────────────────────────
describe('Fix #61 C — cohérence #26 : relances en attente hors fenêtre ignorées', () => {
  it('un conge créé il y a 2 jours (hors J+3 et J+7) n\'est pas relancé', async () => {
    // Créer un conge en_attente_manager créé il y a 2 jours (hors fenêtres J+3/J+7)
    const congeHorsFenetre = await Conge.create({
      entreprise_id:  ctx.entreprise.id,
      utilisateur_id: ctx.employe.id,
      conge_type_id:  ctx.congeType.id,
      date_debut:     dayjs().add(10, 'day').format('YYYY-MM-DD'),
      date_fin:       dayjs().add(10, 'day').format('YYYY-MM-DD'),
      statut:         'en_attente_manager',
      jours_calcules: 1,
    });

    // Forcer created_at à 2 jours (hors [J+3..J+4] et [J+7..J+8])
    await Conge.update(
      { created_at: dayjs().subtract(2, 'day').toDate() },
      { where: { id: congeHorsFenetre.id } }
    );

    await runPendingLeaveReminders();
    expect(emailService.sendEmail).not.toHaveBeenCalled();

    await congeHorsFenetre.destroy();
  });
});
