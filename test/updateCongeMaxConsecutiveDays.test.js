'use strict';
/**
 * updateCongeMaxConsecutiveDays.test.js — Fix #55
 *
 * max_consecutive_days est vérifié à la création de congé mais pas à la
 * modification : updateConge laisse passer des durées qui auraient été
 * refusées à la création.
 *
 * AVANT fix : update vers 10 jours accepté alors que la limite est 3.
 * APRÈS fix  : update vers 10 jours rejeté avec le même message que la création.
 *
 * Cas testés :
 *   A) Modifier un congé de 2j → 10j avec max_consecutive_days=3 → rejeté
 *   B) Modifier un congé de 2j → 3j (exactement la limite)       → accepté
 *   C) Modifier uniquement le commentaire (dates inchangées)       → accepté
 */

const {
  Entreprise, Utilisateur, Conge, CongeType, CompteurConges,
} = require('../src/models');
const { updateConge } = require('../src/services/congesService');

const suffix = String(Date.now()).slice(-6);

let ent, admin, employe, congeType, conge;

beforeAll(async () => {
  ent = await Entreprise.create({
    nom: `MaxConsecUpdate_${suffix}`,
    politique_conges: {
      max_consecutive_days: 3,
      approval_workflow: 'admin_only',
      blocked_days: { exclude_weekends: false, exclude_holidays: false },
    },
    parametres: {},
    statut: 'active',
  });

  admin = await Utilisateur.create({
    prenom: 'Admin', nom: `Consec${suffix}`,
    email: `admin.consec55.${suffix}@test.local`,
    role: 'admin_entreprise',
    password_hash: 'hash',
    statut: 'actif',
    entreprise_id: ent.id,
  });

  employe = await Utilisateur.create({
    prenom: 'Emp', nom: `Consec${suffix}`,
    email: `emp.consec55.${suffix}@test.local`,
    role: 'employe',
    password_hash: 'hash',
    statut: 'actif',
    entreprise_id: ent.id,
  });

  congeType = await CongeType.create({
    libelle: 'CP MaxConsec',
    code: `MXC${suffix}`,
    entreprise_id: ent.id,
    deductible: true,
    demi_journee_autorisee: false,
  });

  await CompteurConges.create({
    entreprise_id: ent.id,
    utilisateur_id: employe.id,
    conge_type_id: congeType.id,
    annee: 2025,
    jours_acquis: 30,
    jours_reserves: 2,
    jours_pris: 0,
    jours_annules: 0,
  });

  // Congé initial : 1 déc → 2 déc 2025 (2 jours, dans la limite de 3)
  conge = await Conge.create({
    entreprise_id: ent.id,
    utilisateur_id: employe.id,
    conge_type_id: congeType.id,
    date_debut: '2025-12-01',
    date_fin:   '2025-12-02',
    debut_demi_journee: 'matin',
    fin_demi_journee:   'apres_midi',
    statut: 'en_attente_manager',
    jours_calcules: 2,
  });
});

afterAll(async () => {
  await Conge.destroy({ where: { entreprise_id: ent.id } });
  await CompteurConges.destroy({ where: { entreprise_id: ent.id } });
  await Utilisateur.destroy({ where: { entreprise_id: ent.id } });
  await CongeType.destroy({ where: { entreprise_id: ent.id } });
  await Entreprise.destroy({ where: { id: ent.id } });
});

// ─────────────────────────────────────────────────────────────────────────────
// A) 2j → 10j avec limite 3 → rejeté
// ─────────────────────────────────────────────────────────────────────────────

describe('Fix #55 A — update dépasse max_consecutive_days', () => {
  it('modifier le congé de 2j à 10j est rejeté quand la limite est 3', async () => {
    // 2025-12-01 → 2025-12-10 = 10 jours calendaires (weekends non exclus)
    await expect(
      updateConge(
        conge.id,
        { date_debut: '2025-12-01', date_fin: '2025-12-10' },
        admin
      )
    ).rejects.toThrow(/Durée maximale dépassée/);
  });

  it('les dates du congé restent inchangées après le rejet', async () => {
    const fresh = await Conge.findByPk(conge.id);
    expect(String(fresh.date_debut).slice(0, 10)).toBe('2025-12-01');
    expect(String(fresh.date_fin).slice(0, 10)).toBe('2025-12-02');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B) 2j → 3j (exactement la limite) → accepté
// ─────────────────────────────────────────────────────────────────────────────

describe('Fix #55 B — update jusqu\'à la limite exacte accepté', () => {
  it('modifier le congé de 2j à 3j est accepté (borne incluse)', async () => {
    // 2025-12-01 → 2025-12-03 = 3 jours calendaires = limite exacte
    await expect(
      updateConge(
        conge.id,
        { date_debut: '2025-12-01', date_fin: '2025-12-03' },
        admin
      )
    ).resolves.not.toThrow();

    const fresh = await Conge.findByPk(conge.id);
    expect(String(fresh.date_fin).slice(0, 10)).toBe('2025-12-03');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C) Commentaire seul (dates inchangées) → accepté (non-régression)
// ─────────────────────────────────────────────────────────────────────────────

describe('Fix #55 C — update commentaire uniquement accepté', () => {
  it('modifier uniquement le commentaire ne déclenche pas la limite de durée', async () => {
    await expect(
      updateConge(
        conge.id,
        { commentaire_employe: 'Test commentaire 55' },
        admin
      )
    ).resolves.not.toThrow();
  });
});
