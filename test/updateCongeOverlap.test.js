'use strict';
/**
 * updateCongeOverlap.test.js
 *
 * BILAN #19 — updateConge ne vérifie pas les chevauchements : modifier les dates
 * d'un congé pour les faire chevaucher un congé existant est actuellement accepté.
 *
 * AVANT fix : la modification réussit même si les nouvelles dates chevauchent un autre congé.
 * APRÈS fix  : erreur 409 / chevauchement ; une modification sans chevauchement reste possible.
 */

const {
  Entreprise, Utilisateur, Conge, CongeType, CompteurConges,
} = require('../src/models');
const { updateConge } = require('../src/services/congesService');

const suffix = String(Date.now()).slice(-6);

let entreprise, admin, employe, congeType, compteur;
let conge1, conge2;

beforeAll(async () => {
  entreprise = await Entreprise.create({
    nom: 'OverlapUpdate-' + suffix,
    politique_conges: {
      approval_workflow: 'admin_only',
      overlap_policy: 'block',
    },
    parametres: {},
  });

  admin = await Utilisateur.create({
    prenom: 'Admin', nom: 'Overlap',
    email: `admin.ov.${suffix}@test.local`,
    role: 'admin_entreprise', password_hash: 'hash', statut: 'actif',
    entreprise_id: entreprise.id,
  });

  employe = await Utilisateur.create({
    prenom: 'Emp', nom: 'Overlap',
    email: `emp.ov.${suffix}@test.local`,
    role: 'employe', password_hash: 'hash', statut: 'actif',
    service: 'Dev',
    entreprise_id: entreprise.id,
  });

  congeType = await CongeType.create({
    libelle: 'Congé Overlap', code: 'OV_' + suffix,
    entreprise_id: entreprise.id,
  });

  // Conge 1 : lun 03 nov → ven 07 nov 2025 (5 jours), en_attente_manager
  // Conge 2 : lun 17 nov → ven 21 nov 2025 (5 jours), valide_final
  // La modification allonge Conge 1 jusqu'au mer 19 nov → chevauche Conge 2 (17-21 nov)
  conge1 = await Conge.create({
    utilisateur_id: employe.id,
    entreprise_id: entreprise.id,
    conge_type_id: congeType.id,
    date_debut: '2025-11-03',
    date_fin:   '2025-11-07',
    debut_demi_journee: 'matin',
    fin_demi_journee:   'apres_midi',
    statut: 'en_attente_manager',
    jours_calcules: 5,
  });

  conge2 = await Conge.create({
    utilisateur_id: employe.id,
    entreprise_id: entreprise.id,
    conge_type_id: congeType.id,
    date_debut: '2025-11-17',
    date_fin:   '2025-11-21',
    debut_demi_journee: 'matin',
    fin_demi_journee:   'apres_midi',
    statut: 'valide_final',
    jours_calcules: 5,
  });

  // Compteur : assez de solde pour que la balance ne bloque pas le test
  compteur = await CompteurConges.create({
    entreprise_id: entreprise.id,
    utilisateur_id: employe.id,
    conge_type_id: congeType.id,
    annee: 2025,
    jours_acquis: 25,
    jours_pris: 5,      // conge2 valide
    jours_reserves: 5,  // conge1 pending
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

describe('updateConge — vérification des chevauchements', () => {
  beforeEach(async () => {
    // Remettre conge1 dans son état initial
    await Conge.update(
      {
        date_debut: '2025-11-03',
        date_fin: '2025-11-07',
        jours_calcules: 5,
        statut: 'en_attente_manager',
      },
      { where: { id: conge1.id } }
    );
    await CompteurConges.update(
      { jours_acquis: 25, jours_pris: 5, jours_reserves: 5 },
      { where: { id: compteur.id } }
    );
  });

  it('modification créant un chevauchement avec un congé existant : doit être rejetée', async () => {
    // Allonge conge1 (03-07 nov) jusqu'au 19 nov → chevauche conge2 (17-21 nov)
    // AVANT fix : réussit (bug)
    // APRÈS fix  : erreur chevauchement
    await expect(
      updateConge(conge1.id, { date_fin: '2025-11-19' }, reqAdmin())
    ).rejects.toThrow(/chevauchement/i);
  });

  it('modification sans chevauchement : doit réussir', async () => {
    // Allonge conge1 jusqu'au 12 nov → pas de chevauchement avec conge2 (17-21 nov)
    await expect(
      updateConge(conge1.id, { date_fin: '2025-11-12' }, reqAdmin())
    ).resolves.toBeDefined();
  });

  it('modification de commentaire uniquement (dates inchangées) : doit réussir', async () => {
    await expect(
      updateConge(conge1.id, { commentaire_employe: 'Motif mis à jour' }, reqAdmin())
    ).resolves.toBeDefined();
  });
});
