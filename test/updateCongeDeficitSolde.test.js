'use strict';
/**
 * updateCongeDeficitSolde.test.js
 *
 * BILAN #18 — updateConge (branche valide_final) accepte une modification qui crée
 * un déficit de solde : Math.max(0, acquis + oldDays - newDays) absorbe silencieusement
 * le manque au lieu de le signaler.
 *
 * AVANT fix : l'extension réussit, jours_acquis clampé à 0 (bug).
 * APRÈS fix  : erreur explicite « Solde insuffisant », compteur inchangé.
 */

const {
  Entreprise, Utilisateur, Conge, CongeType, CompteurConges,
} = require('../src/models');
const { updateConge } = require('../src/services/congesService');

const suffix = String(Date.now()).slice(-6);

let entreprise, admin, employe, congeType, compteur, conge;

beforeAll(async () => {
  entreprise = await Entreprise.create({
    nom: 'DeficitTest-' + suffix,
    politique_conges: { approval_workflow: 'admin_only' },
    parametres: {},
  });

  admin = await Utilisateur.create({
    prenom: 'Admin', nom: 'Deficit',
    email: `admin.deficit.${suffix}@test.local`,
    role: 'admin_entreprise', password_hash: 'hash', statut: 'actif',
    entreprise_id: entreprise.id,
  });

  employe = await Utilisateur.create({
    prenom: 'Emp', nom: 'Deficit',
    email: `emp.deficit.${suffix}@test.local`,
    role: 'employe', password_hash: 'hash', statut: 'actif',
    entreprise_id: entreprise.id,
  });

  congeType = await CongeType.create({
    libelle: 'Congé Deficit', code: 'CD_' + suffix,
    entreprise_id: entreprise.id,
  });

  // Situation : congé de 3 jours déjà approuvé, solde restant = 1 jour seulement.
  // Extension de +2 jours nécessite 2 jours de plus → déficit de 1 jour.
  compteur = await CompteurConges.create({
    entreprise_id: entreprise.id,
    utilisateur_id: employe.id,
    conge_type_id: congeType.id,
    annee: 2025,
    jours_acquis: 1,   // seul 1 jour reste disponible
    jours_pris: 3,
    jours_reserves: 0,
  });

  // Congé valide_final : lun 06 oct → mer 08 oct 2025 (3 jours ouvrés)
  conge = await Conge.create({
    utilisateur_id: employe.id,
    entreprise_id: entreprise.id,
    conge_type_id: congeType.id,
    date_debut: '2025-10-06',
    date_fin:   '2025-10-08',
    debut_demi_journee: 'matin',
    fin_demi_journee:   'apres_midi',
    statut: 'valide_final',
    jours_calcules: 3,  // oldDays = 3
  });
});

afterAll(async () => {
  await Conge.destroy({ where: { entreprise_id: entreprise.id } }).catch(() => {});
  await CompteurConges.destroy({ where: { entreprise_id: entreprise.id } }).catch(() => {});
  await CongeType.destroy({ where: { id: congeType.id } }).catch(() => {});
  for (const u of [admin, employe]) {
    await Utilisateur.destroy({ where: { id: u.id } }).catch(() => {});
  }
  await Entreprise.destroy({ where: { id: entreprise.id } }).catch(() => {});
});

const reqAdmin = () => ({ id: admin.id, role: 'admin_entreprise', entreprise_id: entreprise.id });

describe('updateConge — déficit de solde sur congé valide_final', () => {
  beforeEach(async () => {
    // Réinitialiser le compteur et le congé avant chaque test
    await CompteurConges.update(
      { jours_acquis: 1, jours_pris: 3, jours_reserves: 0 },
      { where: { id: compteur.id } }
    );
    await Conge.update(
      { date_debut: '2025-10-06', date_fin: '2025-10-08', jours_calcules: 3, statut: 'valide_final' },
      { where: { id: conge.id } }
    );
  });

  it('extension créant un déficit : doit être rejetée (solde insuffisant)', async () => {
    // oldDays = 3 (depuis jours_calcules), newDays = 5 (lun-ven)
    // Δ = +2, jours_acquis = 1 → manque 1 jour
    // AVANT fix : Math.max(0, 1 + 3 - 5) = 0 → accepté silencieusement (BUG)
    // APRÈS fix  : erreur levée
    await expect(
      updateConge(conge.id, { date_fin: '2025-10-10' }, reqAdmin())
    ).rejects.toThrow(/solde insuffisant/i);
  });

  it('solde inchangé après un rejet : compteur non altéré', async () => {
    await updateConge(conge.id, { date_fin: '2025-10-10' }, reqAdmin()).catch(() => {});
    const c = await CompteurConges.findByPk(compteur.id);
    // AVANT fix : jours_acquis = 0 (absorbé). APRÈS fix : toujours 1.
    expect(Number(c.jours_acquis)).toBe(1);
    expect(Number(c.jours_pris)).toBe(3);
  });

  it('extension dans la limite du solde : doit réussir', async () => {
    await CompteurConges.update({ jours_acquis: 5 }, { where: { id: compteur.id } });
    // jours_acquis = 5, oldDays = 3, newDays = 5 → Δ = +2, 5 ≥ 2 → OK
    await expect(
      updateConge(conge.id, { date_fin: '2025-10-10' }, reqAdmin())
    ).resolves.toBeDefined();
  });
});
