'use strict';
/**
 * congeTypeQuotaNegatif.test.js — Fix #54
 *
 * updateType accepte quota_annuel négatif sans validation.
 * createType valide correctement (quota_annuel >= 0), mais updateType
 * ne fait aucune vérification et passe la valeur brute à Sequelize.
 *
 * AVANT fix : updateType({ quota_annuel: -10 }) réussit silencieusement.
 * APRÈS fix  : updateType({ quota_annuel: -10 }) lève une AppError 400.
 *
 * Cas testés :
 *   A) quota_annuel=-10  → rejeté (400)
 *   B) quota_annuel=-0.5 → rejeté (400)
 *   C) quota_annuel=0    → accepté (0 est une borne valide)
 *   D) quota_annuel=25   → accepté (valeur nominale)
 *   E) quota_annuel absent du body → accepté (pas de mise à jour du champ)
 */

const { Entreprise, CongeType } = require('../src/models');
const { createType, updateType } = require('../src/services/congeTypesService');

const TS = Date.now();
let ent, congeType;

beforeAll(async () => {
  ent = await Entreprise.create({
    nom: `QuotaNegatif54_${TS}`,
    politique_conges: {},
    parametres: {},
    statut: 'active',
  });

  congeType = await createType(ent.id, {
    code: `QN54_${String(TS).slice(-6)}`,
    libelle: 'Congé test quota négatif',
    quota_annuel: 20,
    demi_journee_autorisee: false,
  });
});

afterAll(async () => {
  await CongeType.destroy({ where: { entreprise_id: ent.id } });
  await Entreprise.destroy({ where: { id: ent.id } });
});

// ─────────────────────────────────────────────────────────────────────────────
// A) quota_annuel=-10 → rejeté
// ─────────────────────────────────────────────────────────────────────────────

describe('Fix #54 A — quota_annuel négatif entier rejeté', () => {
  it('updateType avec quota_annuel=-10 leve une erreur 400', async () => {
    await expect(
      updateType(congeType.id, ent.id, { quota_annuel: -10 })
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('le quota en base reste inchangé après le rejet', async () => {
    const fresh = await CongeType.findByPk(congeType.id);
    expect(Number(fresh.quota_annuel)).toBe(20);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B) quota_annuel=-0.5 → rejeté
// ─────────────────────────────────────────────────────────────────────────────

describe('Fix #54 B — quota_annuel négatif décimal rejeté', () => {
  it('updateType avec quota_annuel=-0.5 leve une erreur 400', async () => {
    await expect(
      updateType(congeType.id, ent.id, { quota_annuel: -0.5 })
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C) quota_annuel=0 → accepté
// ─────────────────────────────────────────────────────────────────────────────

describe('Fix #54 C — quota_annuel=0 accepté (borne inférieure valide)', () => {
  it('updateType avec quota_annuel=0 ne leve pas d\'erreur', async () => {
    await expect(
      updateType(congeType.id, ent.id, { quota_annuel: 0 })
    ).resolves.not.toThrow();

    const fresh = await CongeType.findByPk(congeType.id);
    expect(Number(fresh.quota_annuel)).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D) quota_annuel=25 → accepté
// ─────────────────────────────────────────────────────────────────────────────

describe('Fix #54 D — quota_annuel positif accepté', () => {
  it('updateType avec quota_annuel=25 met bien à jour la valeur', async () => {
    await updateType(congeType.id, ent.id, { quota_annuel: 25 });
    const fresh = await CongeType.findByPk(congeType.id);
    expect(Number(fresh.quota_annuel)).toBe(25);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E) quota_annuel absent → accepté (non-régression)
// ─────────────────────────────────────────────────────────────────────────────

describe('Fix #54 E — body sans quota_annuel accepté (non-régression)', () => {
  it('updateType sans quota_annuel ne modifie pas le quota existant', async () => {
    await updateType(congeType.id, ent.id, { libelle: 'Nouveau libellé 54' });
    const fresh = await CongeType.findByPk(congeType.id);
    expect(fresh.libelle).toBe('Nouveau libellé 54');
    expect(Number(fresh.quota_annuel)).toBe(25); // valeur du test D
  });
});
