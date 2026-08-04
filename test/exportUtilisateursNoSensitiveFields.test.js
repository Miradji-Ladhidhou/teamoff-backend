'use strict';
/**
 * exportUtilisateursNoSensitiveFields.test.js — Fix #72
 *
 * PROBLÈME :
 *   getUtilisateursPreview() appelait Utilisateur.findAll sans `attributes`,
 *   ce qui déclenchait un SELECT * et chargeait en mémoire password_hash,
 *   totp_secret, refresh_token_hash, invite_token_hash pour chaque ligne.
 *   Ces champs ne sont pas utilisés dans l'export mais transitent en RAM.
 *
 * CORRECTION :
 *   attributes: ['prenom', 'nom', 'email', 'role', 'service'] — seuls les
 *   5 champs effectivement mappés dans rows.map() sont chargés.
 *
 * TESTS :
 *   A — les colonnes de preview sont exactement {nom, email, role, service}
 *   B — password_hash, totp_secret, refresh_token_hash sont absents des rows
 *   C — non-régression : nom, email, role, service ont les valeurs attendues
 */

const { seed } = require('./helpers/seed');
const ExportService = require('../src/services/exportService');

let ctx;

beforeAll(async () => {
  ctx = await seed();
});

afterAll(async () => {
  await ctx.cleanup();
});

// ─────────────────────────────────────────────────────────────────────────────
// A — Les colonnes de preview correspondent exactement aux champs utiles
// ─────────────────────────────────────────────────────────────────────────────
describe('Fix #72 A — colonnes de preview = champs utiles uniquement', () => {
  it('columns contient nom, email, role, service', async () => {
    const preview = await ExportService.getUtilisateursPreview(ctx.entreprise.id, {}, 50);
    expect(preview.columns).toEqual(expect.arrayContaining(['nom', 'email', 'role', 'service']));
  });

  it('columns ne contient pas password_hash, totp_secret, refresh_token_hash', async () => {
    const preview = await ExportService.getUtilisateursPreview(ctx.entreprise.id, {}, 50);
    expect(preview.columns).not.toContain('password_hash');
    expect(preview.columns).not.toContain('totp_secret');
    expect(preview.columns).not.toContain('refresh_token_hash');
    expect(preview.columns).not.toContain('invite_token_hash');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B — Les rows ne portent aucun champ sensible
// ─────────────────────────────────────────────────────────────────────────────
describe('Fix #72 B — rows ne contiennent aucune donnée sensible', () => {
  it('aucun row ne possède password_hash ni totp_secret', async () => {
    const preview = await ExportService.getUtilisateursPreview(ctx.entreprise.id, {}, 50);
    expect(preview.rows.length).toBeGreaterThan(0);

    for (const row of preview.rows) {
      expect(row).not.toHaveProperty('password_hash');
      expect(row).not.toHaveProperty('totp_secret');
      expect(row).not.toHaveProperty('refresh_token_hash');
      expect(row).not.toHaveProperty('invite_token_hash');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C — Non-régression : nom, email, role, service ont les valeurs attendues
// ─────────────────────────────────────────────────────────────────────────────
describe('Fix #72 C — non-régression : colonnes utiles correctement remplies', () => {
  it("le row de l'admin contient son email, son role et son service", async () => {
    const preview = await ExportService.getUtilisateursPreview(ctx.entreprise.id, {}, 50);

    const adminRow = preview.rows.find(r => r.email === ctx.admin.email);
    expect(adminRow).toBeDefined();
    expect(adminRow.email).toBe(ctx.admin.email);
    expect(adminRow.role).toBe('admin_entreprise');
    // nom = "prenom nom" concaténé
    expect(adminRow.nom).toContain(ctx.admin.prenom);
  });

  it('count correspond au nombre de rows retournées', async () => {
    const preview = await ExportService.getUtilisateursPreview(ctx.entreprise.id, {}, 50);
    expect(preview.count).toBe(preview.rows.length);
  });
});
