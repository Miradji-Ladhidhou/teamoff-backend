'use strict';
/**
 * auditExportDateFilter.test.js — Fix #50
 *
 * getAuditPreview accepte les filtres dateDebut/dateFin mais ne les applique
 * pas à la requête : tous les logs de l'entreprise sont toujours retournés.
 *
 * AVANT fix : un log de 2020 est inclus même si dateDebut=2023.
 * APRÈS fix  : seuls les logs dans la plage sélectionnée sont retournés.
 *
 * Cas testés :
 *   A) dateDebut exclut les entrées trop anciennes
 *   B) dateFin exclut les entrées trop récentes
 *   C) Sans filtre : tout est retourné (non-régression)
 */

const { AuditLog, Entreprise, sequelize } = require('../src/models');
const ExportService = require('../src/services/exportService');

const TS = Date.now();

let ent;
// IDs des logs créés pour cet isolat de test
const logIds = [];

beforeAll(async () => {
  ent = await Entreprise.create({
    nom: `AuditFilter_${TS}`,
    politique_conges: {},
    parametres: {},
    statut: 'active',
  });

  // Log "ancien" : 2020-03-15 — doit être hors plage dans les tests A et C(dateFin)
  const logOld = await AuditLog.create({
    action: 'AUDIT_FILTER_OLD',
    entity: 'test',
    entreprise_id: ent.id,
    user_id: null,
  });
  logIds.push(logOld.id);
  // Forcer created_at à 2020 via UPDATE direct (Sequelize ne permet pas de
  // surcharger createdAt à la création sans contourner les hooks de timestamp)
  await sequelize.query(
    "UPDATE audit_logs SET created_at = '2020-03-15 10:00:00' WHERE id = :id",
    { replacements: { id: logOld.id } }
  );

  // Log "milieu" : 2023-06-01 — dans la plage des tests A et B
  const logMid = await AuditLog.create({
    action: 'AUDIT_FILTER_MID',
    entity: 'test',
    entreprise_id: ent.id,
    user_id: null,
  });
  logIds.push(logMid.id);
  await sequelize.query(
    "UPDATE audit_logs SET created_at = '2023-06-01 12:00:00' WHERE id = :id",
    { replacements: { id: logMid.id } }
  );

  // Log "récent" : 2099-01-01 — doit être hors plage dans le test B
  const logFuture = await AuditLog.create({
    action: 'AUDIT_FILTER_FUTURE',
    entity: 'test',
    entreprise_id: ent.id,
    user_id: null,
  });
  logIds.push(logFuture.id);
  await sequelize.query(
    "UPDATE audit_logs SET created_at = '2099-01-01 00:00:00' WHERE id = :id",
    { replacements: { id: logFuture.id } }
  );
});

afterAll(async () => {
  await AuditLog.destroy({ where: { id: logIds } });
  await Entreprise.destroy({ where: { id: ent.id } });
});

// ─────────────────────────────────────────────────────────────────────────────
// A) dateDebut exclut le log de 2020
// ─────────────────────────────────────────────────────────────────────────────

describe('Fix #50 A — dateDebut exclut les logs antérieurs', () => {
  it('log de 2020 absent, log de 2023 et 2099 présents avec dateDebut=2021-01-01', async () => {
    const result = await ExportService.getAuditPreview(
      ent.id,
      { dateDebut: '2021-01-01' },
      100
    );
    const actions = result.rows.map((r) => r.action);
    expect(actions).not.toContain('AUDIT_FILTER_OLD');
    expect(actions).toContain('AUDIT_FILTER_MID');
    expect(actions).toContain('AUDIT_FILTER_FUTURE');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B) dateFin exclut le log de 2099
// ─────────────────────────────────────────────────────────────────────────────

describe('Fix #50 B — dateFin exclut les logs postérieurs', () => {
  it('log de 2099 absent, log de 2020 et 2023 présents avec dateFin=2024-12-31', async () => {
    const result = await ExportService.getAuditPreview(
      ent.id,
      { dateFin: '2024-12-31' },
      100
    );
    const actions = result.rows.map((r) => r.action);
    expect(actions).not.toContain('AUDIT_FILTER_FUTURE');
    expect(actions).toContain('AUDIT_FILTER_OLD');
    expect(actions).toContain('AUDIT_FILTER_MID');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C) Sans filtre : les trois logs sont retournés (non-régression)
// ─────────────────────────────────────────────────────────────────────────────

describe('Fix #50 C — sans filtre, tous les logs de l\'entreprise retournés', () => {
  it('les trois logs présents sans filtre de date', async () => {
    const result = await ExportService.getAuditPreview(ent.id, {}, 100);
    const actions = result.rows.map((r) => r.action);
    expect(actions).toContain('AUDIT_FILTER_OLD');
    expect(actions).toContain('AUDIT_FILTER_MID');
    expect(actions).toContain('AUDIT_FILTER_FUTURE');
  });
});
