'use strict';
/**
 * quotasMonthKeyComparison.test.js — Fix #65
 *
 * PROBLÈME :
 *   dernier_credit_mensuel est comparé avec > (chaîne de caractères).
 *   Si la DB contient "2026-9" (ancien format sans zero-padding) et que
 *   targetMonthKey = "2026-10" (format actuel avec padStart), alors
 *   "2026-9" > "2026-10" → true → hasFutureCredit = true → crédit sauté.
 *
 * CORRECTION :
 *   Normaliser lastCreditMonth avec normalizeMonthKey() avant comparaison :
 *   "2026-9" → "2026-09", puis "2026-09" > "2026-10" → false → crédit appliqué.
 *
 * TESTS :
 *   A — documentation du comportement JS lexicographique qui cause le bug
 *   B — fonctionnel : un compteur avec "2026-9" en DB reçoit le crédit d'octobre
 *       (ÉCHOUE avant fix, PASSE après fix)
 */

const { seed }  = require('./helpers/seed');
const { CompteurConges, sequelize } = require('../src/models');
const { ajouterAcquisitionMensuelle } = require('../src/services/quotasService');

let ctx;

beforeAll(async () => {
  ctx = await seed();
});

afterAll(async () => {
  await CompteurConges.destroy({ where: { entreprise_id: ctx.entreprise.id } });
  await ctx.cleanup();
});

// ─────────────────────────────────────────────────────────────────────────────
// A — Documentation : comparaison lexicographique JS
// ─────────────────────────────────────────────────────────────────────────────
describe('Fix #65 A — comportement lexicographique JS (documentation du bug)', () => {
  it('"2026-9" > "2026-10" vaut true en JS (comparaison chaîne = bug)', () => {
    // "9" > "1" en ASCII — c'est le comportement natif qui provoque le faux positif
    expect('2026-9' > '2026-10').toBe(true);
  });

  it('"2026-8" > "2026-09" vaut true (août non-paddé > septembre paddé = bug)', () => {
    // "8" > "0" — même cause : saute septembre alors qu'août était le dernier crédit
    expect('2026-8' > '2026-09').toBe(true);
  });

  it('"2026-09" > "2026-10" vaut false (après normalisation = correct)', () => {
    // Une fois normalisé, la comparaison lexicographique est valide pour YYYY-MM
    expect('2026-09' > '2026-10').toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B — Fonctionnel : compteur avec "2026-9" en DB reçoit le crédit d'octobre
//     ÉCHOUE avant fix (skipped=1, applied=0)
//     PASSE  après fix (skipped=0, applied=1)
// ─────────────────────────────────────────────────────────────────────────────
describe('Fix #65 B — compteur non-paddé "2026-9" → crédit octobre appliqué', () => {
  let compteur;

  beforeAll(async () => {
    // Pré-condition : créer un compteur avec dernier_credit_mensuel en ancien format non-paddé.
    // Supprimer d'abord le compteur créé par seed (même clé composite) pour éviter le conflit.
    await CompteurConges.destroy({
      where: { utilisateur_id: ctx.employe.id, conge_type_id: ctx.congeType.id, annee: 2026, entreprise_id: ctx.entreprise.id },
    });
    compteur = await CompteurConges.create({
      entreprise_id:          ctx.entreprise.id,
      utilisateur_id:         ctx.employe.id,
      conge_type_id:          ctx.congeType.id,
      annee:                  2026,
      jours_acquis:           5,
      jours_pris:             0,
      jours_reportes:         0,
      jours_reserves:         0,
      jours_annules:          0,
      dernier_credit_mensuel: null,  // on le fixe juste après via UPDATE brut
    });

    // Injecter "2026-9" via UPDATE raw — contourne les helpers qui padStart
    await sequelize.query(
      `UPDATE compteur_conges SET dernier_credit_mensuel = '2026-9' WHERE id = :id`,
      { replacements: { id: compteur.id } }
    );
  });

  afterAll(async () => {
    if (compteur) await compteur.destroy();
  });

  it('ajouterAcquisitionMensuelle octobre 2026 applique le crédit (apply=true)', async () => {
    const result = await ajouterAcquisitionMensuelle(
      ctx.entreprise.id,
      2026,
      10,           // octobre
      { apply: true }
    );

    // Avant fix : applied = 0, skipped = 1 (hasFutureCredit = true par erreur)
    // Après fix : applied = 1, skipped = 0
    expect(result.applied).toBeGreaterThanOrEqual(1);
    expect(result.skipped).toBe(0);

    // Le champ doit maintenant être "2026-10"
    await compteur.reload();
    expect(compteur.dernier_credit_mensuel).toBe('2026-10');
  });
});
