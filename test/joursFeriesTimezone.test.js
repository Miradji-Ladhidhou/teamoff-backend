'use strict';
/**
 * joursFeriesTimezone.test.js — Fix #60
 *
 * PROBLÈME :
 *   getJoursFeriesByMonth calcule les bornes avec new Date(y, m-1, 1) (heure locale).
 *   .toISOString() convertit ensuite en UTC → en UTC+9, Sep 1 00:00 local
 *   = Aug 31 15:00 UTC → slice(0,10) = "2025-08-31".  Résultat : le dernier
 *   jour du mois (Sep 30) tombe hors de la plage BETWEEN et n'est pas retourné.
 *
 * TESTS :
 *   A — unité : démontre mathématiquement le décalage en UTC+9 (old code)
 *   B — unité : confirme que Date.UTC donne la borne correcte (new code / fix)
 *   C — intégration : les jours fériés en début et fin de mois sont retournés
 *                     (échoue avant fix si le process tourne en UTC+9)
 */

// Force la timezone AVANT toute instanciation de Date — indispensable pour que
// new Date(y, m-1, d) reflète bien UTC+9 dans les tests unitaires A et B.
process.env.TZ = 'Asia/Tokyo'; // UTC+9, pas de DST

const request = require('supertest');
const app     = require('../src/index');
const { seed } = require('./helpers/seed');
const { JoursFeries } = require('../src/models');

let ctx;

beforeAll(async () => {
  ctx = await seed();

  // Jours fériés sur les bornes de septembre 2025 + mi-mois
  await JoursFeries.bulkCreate([
    { entreprise_id: ctx.entreprise.id, date: '2025-09-01', libelle: 'Borne début #60', recurrent: false, est_travail: false },
    { entreprise_id: ctx.entreprise.id, date: '2025-09-15', libelle: 'Mi-mois #60',   recurrent: false, est_travail: false },
    { entreprise_id: ctx.entreprise.id, date: '2025-09-30', libelle: 'Borne fin #60',  recurrent: false, est_travail: false },
  ]);
});

afterAll(async () => {
  await JoursFeries.destroy({ where: { entreprise_id: ctx.entreprise.id } });
  await ctx.cleanup();
});

// ─────────────────────────────────────────────────────────────────────────────
// A — Démonstration du bug : old code donne des bornes erronées en UTC+9
// ─────────────────────────────────────────────────────────────────────────────
describe('Fix #60 A — new Date(y, m-1, 1) décale d\'un jour en UTC+9', () => {
  it('startDate en UTC+9 : ISO slice ≠ premier jour du mois', () => {
    // En UTC+9, new Date(2025, 8, 1) = Sep 1 00:00 local = Aug 31 15:00 UTC
    const startDate = new Date(2025, 8, 1); // old code
    // .toISOString() retourne "2025-08-31T15:00:00.000Z"
    expect(startDate.toISOString().slice(0, 10)).toBe('2025-08-31'); // bug
    expect(startDate.toISOString().slice(0, 10)).not.toBe('2025-09-01');
  });

  it('endDate en UTC+9 : ISO slice ≠ dernier jour du mois', () => {
    // En UTC+9, new Date(2025, 9, 0) = Sep 30 00:00 local = Sep 29 15:00 UTC
    const endDate = new Date(2025, 9, 0); // old code
    expect(endDate.toISOString().slice(0, 10)).toBe('2025-09-29'); // bug
    expect(endDate.toISOString().slice(0, 10)).not.toBe('2025-09-30');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B — Vérification du fix : Date.UTC donne les bonnes bornes dans toute timezone
// ─────────────────────────────────────────────────────────────────────────────
describe('Fix #60 B — Date.UTC(y, m-1, 1) est toujours correct', () => {
  it('startDate avec Date.UTC = premier jour du mois', () => {
    const startDate = new Date(Date.UTC(2025, 8, 1)); // new code
    expect(startDate.toISOString().slice(0, 10)).toBe('2025-09-01');
  });

  it('endDate avec Date.UTC = dernier jour du mois', () => {
    const endDate = new Date(Date.UTC(2025, 9, 0)); // new code
    expect(endDate.toISOString().slice(0, 10)).toBe('2025-09-30');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C — Intégration : l'endpoint retourne les jours des bornes (Sep 1 et Sep 30)
//     ÉCHOUE avant fix (UTC+9 : Sep 30 tombe hors de [Aug 31, Sep 29])
//     PASSE  après fix (UTC   : plage correcte [Sep 01, Sep 30])
// ─────────────────────────────────────────────────────────────────────────────
describe('Fix #60 C — GET /jours-feries/2025/9 retourne toutes les bornes', () => {
  it('Sep 1, Sep 15 et Sep 30 sont tous présents dans la réponse', async () => {
    const res = await request(app)
      .get('/api/jours-feries/2025/9')
      .set('Authorization', `Bearer ${ctx.tokens.admin}`);

    expect(res.status).toBe(200);

    const nonRecurrent = res.body.filter(j => !j.recurrent).map(j => j.date);
    expect(nonRecurrent).toContain('2025-09-01');
    expect(nonRecurrent).toContain('2025-09-15');
    expect(nonRecurrent).toContain('2025-09-30'); // manquait avant fix en UTC+9
  });
});
