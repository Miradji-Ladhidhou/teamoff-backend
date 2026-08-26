'use strict';
/**
 * arretsMaladieServiceFilter.test.js — Fix #51
 *
 * getArretsMaladiePreview ignorait filters.service : tous les arrêts maladie
 * de l'entreprise étaient retournés quel que soit le service demandé.
 *
 * AVANT fix : filtrer par service='RH' retournait aussi l'employé du service 'IT'.
 * APRÈS fix  : seuls les arrêts des employés du service demandé sont retournés.
 *
 * Cas testés :
 *   A) filters.service='RH' → seul l'employé RH est dans les résultats
 *   B) filters.service='IT' → seul l'employé IT est dans les résultats
 *   C) Pas de filtre service → les deux employés sont retournés (non-régression)
 */

const bcrypt = require('bcrypt');
const {
  Entreprise, Utilisateur, Absence, sequelize,
} = require('../src/models');
const ExportService = require('../src/services/exportService');

const TS = Date.now();

let ent, empRH, empIT, absenceRH, absenceIT;

beforeAll(async () => {
  const hash = await bcrypt.hash('Test1234!', 10);

  ent = await Entreprise.create({
    nom: `ArretServiceFilter_${TS}`,
    politique_conges: {},
    parametres: {},
    statut: 'active',
  });

  empRH = await Utilisateur.create({
    entreprise_id: ent.id,
    prenom: 'Alice',
    nom: 'RH51',
    email: `alice.rh.51.${TS}@test.internal`,
    role: 'employe',
    password_hash: hash,
    statut: 'actif',
    service: 'RH',
  });

  empIT = await Utilisateur.create({
    entreprise_id: ent.id,
    prenom: 'Bob',
    nom: 'IT51',
    email: `bob.it.51.${TS}@test.internal`,
    role: 'employe',
    password_hash: hash,
    statut: 'actif',
    service: 'IT',
  });

  absenceRH = await Absence.create({
    entreprise_id: ent.id,
    utilisateur_id: empRH.id,
    type_absence: 'maladie',
    date_debut: '2024-03-01',
    date_fin: '2024-03-05',
    statut: 'approuvée',
  });

  absenceIT = await Absence.create({
    entreprise_id: ent.id,
    utilisateur_id: empIT.id,
    type_absence: 'maladie',
    date_debut: '2024-04-10',
    date_fin: '2024-04-12',
    statut: 'approuvée',
  });
});

afterAll(async () => {
  await Absence.destroy({ where: { entreprise_id: ent.id } });
  await Utilisateur.destroy({ where: { entreprise_id: ent.id } });
  await Entreprise.destroy({ where: { id: ent.id } });
});

// ─────────────────────────────────────────────────────────────────────────────
// A) filters.service='RH' → seul l'employé RH
// ─────────────────────────────────────────────────────────────────────────────

describe('Fix #51 A — filtre service=RH exclut les autres services', () => {
  it("seul l'arret de l'employe RH est retourne", async () => {
    const result = await ExportService.getArretsMaladiePreview(
      ent.id,
      { service: 'RH' },
      50
    );
    const emails = result.rows.map((r) => r.email);
    expect(emails).toContain(empRH.email);
    expect(emails).not.toContain(empIT.email);
  });

  it('la ligne retournee porte bien le champ service=RH', async () => {
    const result = await ExportService.getArretsMaladiePreview(
      ent.id,
      { service: 'RH' },
      50
    );
    const row = result.rows.find((r) => r.email === empRH.email);
    expect(row.service).toBe('RH');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B) filters.service='IT' → seul l'employé IT
// ─────────────────────────────────────────────────────────────────────────────

describe('Fix #51 B — filtre service=IT exclut les autres services', () => {
  it("seul l'arret de l'employe IT est retourne", async () => {
    const result = await ExportService.getArretsMaladiePreview(
      ent.id,
      { service: 'IT' },
      50
    );
    const emails = result.rows.map((r) => r.email);
    expect(emails).toContain(empIT.email);
    expect(emails).not.toContain(empRH.email);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C) Sans filtre service → les deux employés (non-régression)
// ─────────────────────────────────────────────────────────────────────────────

describe('Fix #51 C — sans filtre service, tous les arrets de l\'entreprise retournes', () => {
  it('les deux arrets presentes sans filtre', async () => {
    const result = await ExportService.getArretsMaladiePreview(ent.id, {}, 50);
    const emails = result.rows.map((r) => r.email);
    expect(emails).toContain(empRH.email);
    expect(emails).toContain(empIT.email);
  });
});
