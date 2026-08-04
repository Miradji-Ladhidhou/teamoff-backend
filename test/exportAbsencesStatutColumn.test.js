'use strict';
/**
 * exportAbsencesStatutColumn.test.js — Fix #73
 *
 * PROBLÈME :
 *   getAbsencesPreview() mappait les rows sans inclure le champ `statut`,
 *   alors que generateAbsencesPDF() déclare la colonne { key: 'statut', ... }.
 *   Résultat : la colonne "Statut" était vide dans tous les exports PDF/CSV.
 *
 * CORRECTION :
 *   Ajout de `statut: a.statut` dans le rows.map() de getAbsencesPreview().
 *
 * TESTS :
 *   A — `statut` est présent dans les columns de la preview
 *   B — `statut` est valorisé avec la valeur réelle dans chaque row
 *   C — non-régression : les autres colonnes (employe, email, type, debut, fin) restent présentes
 */

const { seed } = require('./helpers/seed');
const ExportService = require('../src/services/exportService');
const { Absence } = require('../src/models');

let ctx;

beforeAll(async () => {
  ctx = await seed();

  await Absence.create({
    entreprise_id: ctx.entreprise.id,
    utilisateur_id: ctx.employe.id,
    type_absence: 'absence_exceptionnelle',
    date_debut: new Date(2025, 6, 14),
    date_fin: new Date(2025, 6, 18),
    statut: 'signalée',
  });

  await Absence.create({
    entreprise_id: ctx.entreprise.id,
    utilisateur_id: ctx.employe.id,
    type_absence: 'absence_exceptionnelle',
    date_debut: new Date(2025, 7, 4),
    date_fin: new Date(2025, 7, 8),
    statut: 'approuvée',
  });
});

afterAll(async () => {
  await ctx.cleanup();
});

// ─────────────────────────────────────────────────────────────────────────────
// A — `statut` apparaît dans les colonnes de la preview
// ─────────────────────────────────────────────────────────────────────────────
describe('Fix #73 A — colonne "statut" présente dans la preview', () => {
  it('columns contient "statut"', async () => {
    const preview = await ExportService.getAbsencesPreview(ctx.entreprise.id, {}, 50);
    expect(preview.columns).toContain('statut');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B — `statut` est valorisé avec la valeur réelle de chaque absence
// ─────────────────────────────────────────────────────────────────────────────
describe('Fix #73 B — valeur réelle du statut dans chaque row', () => {
  let preview;

  beforeAll(async () => {
    preview = await ExportService.getAbsencesPreview(ctx.entreprise.id, {}, 50);
  });

  it('les rows de l\'employé contiennent au moins un statut "signalée"', () => {
    const employe_rows = preview.rows.filter(r => r.email === ctx.employe.email);
    const statuts = employe_rows.map(r => r.statut);
    expect(statuts).toContain('signalée');
  });

  it('les rows de l\'employé contiennent au moins un statut "approuvée"', () => {
    const employe_rows = preview.rows.filter(r => r.email === ctx.employe.email);
    const statuts = employe_rows.map(r => r.statut);
    expect(statuts).toContain('approuvée');
  });

  it('aucun row n\'a statut undefined ou null', () => {
    expect(preview.rows.length).toBeGreaterThan(0);
    for (const row of preview.rows) {
      expect(row.statut).toBeDefined();
      expect(row.statut).not.toBeNull();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C — Non-régression : toutes les colonnes attendues sont présentes
// ─────────────────────────────────────────────────────────────────────────────
describe('Fix #73 C — non-régression : toutes les colonnes présentes', () => {
  it('columns = [employe, email, service, type, debut, fin, statut]', async () => {
    const preview = await ExportService.getAbsencesPreview(ctx.entreprise.id, {}, 50);
    const expected = ['employe', 'email', 'service', 'type', 'debut', 'fin', 'statut'];
    expect(preview.columns).toEqual(expected);
  });
});
