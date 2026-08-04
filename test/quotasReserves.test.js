'use strict';
/**
 * quotasReserves.test.js
 *
 * Vérifie que createOrUpdateCounter ne peut pas mettre jours_reserves
 * à une valeur inférieure aux jours réellement réservés par des congés en attente.
 *
 * AVANT fix : createOrUpdateCounter avec jours_reserves=0 réussit même si
 *             des congés en attente occupent des jours → double consommation silencieuse
 * APRÈS fix  : l'appel lève une erreur avec le montant pending réel, OU
 *              jours_reserves est préservé si non fourni dans le payload
 */

const { Entreprise, Utilisateur, CongeType, CompteurConges, Conge } = require('../src/models');
const { createOrUpdateCounter } = require('../src/services/quotasService');

let entreprise, employe, congeType, compteur, congePending;

beforeAll(async () => {
  entreprise = await Entreprise.create({
    nom: 'QuotasReserveTest-' + Date.now(),
    politique_conges: { approval_workflow: 'manager_admin' },
    parametres: {},
  });

  employe = await Utilisateur.create({
    prenom: 'Emp', nom: 'Reserve',
    email: `emp.reserve.${Date.now()}@test.local`,
    role: 'employe', password_hash: 'hash', statut: 'actif',
    entreprise_id: entreprise.id,
  });

  const suffix = String(Date.now()).slice(-6);
  congeType = await CongeType.create({
    libelle: 'CP Test Reserves',
    code: 'QR_' + suffix,
    entreprise_id: entreprise.id,
  });

  compteur = await CompteurConges.create({
    entreprise_id: entreprise.id,
    utilisateur_id: employe.id,
    conge_type_id: congeType.id,
    annee: 2025,
    jours_acquis: 20,
    jours_pris: 0,
    jours_reserves: 5,   // 5 jours déjà réservés par un congé en attente
  });

  // Congé en attente qui justifie les 5 jours réservés
  congePending = await Conge.create({
    utilisateur_id: employe.id,
    entreprise_id: entreprise.id,
    conge_type_id: congeType.id,
    date_debut: '2025-11-03',
    date_fin: '2025-11-07',
    debut_demi_journee: 'matin',
    fin_demi_journee: 'apres_midi',
    statut: 'en_attente_manager',
    jours_calcules: 5,
  });
});

afterAll(async () => {
  if (congePending) await Conge.destroy({ where: { id: congePending.id } }).catch(() => {});
  if (compteur)     await CompteurConges.destroy({ where: { id: compteur.id } }).catch(() => {});
  if (congeType)    await CongeType.destroy({ where: { id: congeType.id } }).catch(() => {});
  if (employe)      await Utilisateur.destroy({ where: { id: employe.id } }).catch(() => {});
  if (entreprise)   await Entreprise.destroy({ where: { id: entreprise.id } }).catch(() => {});
});

describe('createOrUpdateCounter — protection de jours_reserves', () => {
  it('zeroing explicite (jours_reserves=0) avec congés en attente lève une erreur', async () => {
    await expect(
      createOrUpdateCounter({
        entrepriseId: entreprise.id,
        utilisateurId: employe.id,
        congeTypeId: congeType.id,
        annee: 2025,
        values: { jours_acquis: 20, jours_reserves: 0 },
      })
    ).rejects.toThrow(/réservé|pending|attente|5/i);
  });

  it('jours_reserves reste inchangé si non fourni dans le payload', async () => {
    await createOrUpdateCounter({
      entrepriseId: entreprise.id,
      utilisateurId: employe.id,
      congeTypeId: congeType.id,
      annee: 2025,
      values: { jours_acquis: 22 }, // jours_reserves absent du payload
    });

    await compteur.reload();
    // Ne doit PAS être à 0 — les 5 jours réservés doivent être préservés
    expect(Number(compteur.jours_reserves)).toBe(5);
    expect(Number(compteur.jours_acquis)).toBe(22);
  });

  it('mise à jour légitime de jours_reserves ≥ pending est acceptée', async () => {
    await createOrUpdateCounter({
      entrepriseId: entreprise.id,
      utilisateurId: employe.id,
      congeTypeId: congeType.id,
      annee: 2025,
      values: { jours_acquis: 22, jours_reserves: 5 }, // exactement les pending
    });

    await compteur.reload();
    expect(Number(compteur.jours_reserves)).toBe(5);
  });

  it('mise à jour avec jours_reserves > pending est acceptée', async () => {
    await createOrUpdateCounter({
      entrepriseId: entreprise.id,
      utilisateurId: employe.id,
      congeTypeId: congeType.id,
      annee: 2025,
      values: { jours_acquis: 22, jours_reserves: 8 }, // supérieur aux pending → OK
    });

    await compteur.reload();
    expect(Number(compteur.jours_reserves)).toBe(8);

    // Remettre à 5 pour les tests suivants
    await compteur.update({ jours_reserves: 5 });
  });

  it('sans congés en attente, zeroing de jours_reserves est autorisé', async () => {
    // Mettre le congé en statut final (plus en attente)
    await congePending.update({ statut: 'valide_final' });

    await expect(
      createOrUpdateCounter({
        entrepriseId: entreprise.id,
        utilisateurId: employe.id,
        congeTypeId: congeType.id,
        annee: 2025,
        values: { jours_acquis: 20, jours_reserves: 0 },
      })
    ).resolves.toBeDefined();

    await compteur.reload();
    expect(Number(compteur.jours_reserves)).toBe(0);

    // Remettre en attente et restaurer les réserves pour le teardown
    await congePending.update({ statut: 'en_attente_manager' });
    await compteur.update({ jours_acquis: 20, jours_reserves: 5 });
  });
});
