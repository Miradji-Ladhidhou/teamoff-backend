'use strict';
/**
 * feriesRecurrents.test.js
 *
 * Confirme le bug : un jour férié récurrent enregistré en 2020
 * est ignoré lors d'un congé posé la même date en 2024.
 *
 * AVANT fix : calcJoursConges compte 1 jour ouvré pour Noël 2024
 *             alors que Noël 2020 est en base avec recurrent=true → FAIL
 * APRÈS fix  : calcJoursConges compte 0 jours (férié reconnu) → PASS
 */

const { Entreprise, JoursFeries } = require('../src/models');
const { calcJoursConges } = require('../src/services/congesService');

let entreprise, ferieNoel2020, ferieSpecifique2024;

beforeAll(async () => {
  entreprise = await Entreprise.create({
    nom: 'TestFeriesRecurrents-' + Date.now(),
    politique_conges: {},
    parametres: {},
  });

  // Noël 2020 — marqué récurrent : doit exclure le 25 déc de TOUTE année
  ferieNoel2020 = await JoursFeries.create({
    entreprise_id: entreprise.id,
    date: '2020-12-25',
    libelle: 'Noël',
    recurrent: true,
    est_travail: false,
  });

  // 1er mai 2022 — NON récurrent : ne doit exclure QUE le 1er mai 2022
  ferieSpecifique2024 = await JoursFeries.create({
    entreprise_id: entreprise.id,
    date: '2022-05-01',
    libelle: 'Fête du Travail 2022',
    recurrent: false,
    est_travail: false,
  });
});

afterAll(async () => {
  if (ferieNoel2020)      await JoursFeries.destroy({ where: { id: ferieNoel2020.id } }).catch(() => {});
  if (ferieSpecifique2024) await JoursFeries.destroy({ where: { id: ferieSpecifique2024.id } }).catch(() => {});
  if (entreprise)          await Entreprise.destroy({ where: { id: entreprise.id } }).catch(() => {});
});

describe('Jours fériés récurrents — calcJoursConges', () => {
  it('Noël 2024 est exclu grâce au férié récurrent enregistré en 2020', async () => {
    // 25 déc 2024 = mercredi (jour ouvré, non exclu comme week-end)
    const jours = await calcJoursConges(entreprise.id, '2024-12-25', '2024-12-25', 'matin', 'apres_midi');
    // Devrait être 0 : jour férié récurrent → non compté
    expect(jours).toBe(0);
  });

  it('Noël 2020 lui-même est aussi exclu (bonne date de référence)', async () => {
    // 25 déc 2020 = vendredi (jour ouvré)
    const jours = await calcJoursConges(entreprise.id, '2020-12-25', '2020-12-25', 'matin', 'apres_midi');
    expect(jours).toBe(0);
  });

  it('Un férié non récurrent est exclu uniquement sur son année exacte', async () => {
    // 1er mai 2022 (dimanche — week-end, mais testons avec un exemple plus clair)
    // On teste le 2 mai 2022 pour éviter l'effet week-end — il n'est PAS férié
    const joursMai2022 = await calcJoursConges(entreprise.id, '2022-05-02', '2022-05-02', 'matin', 'apres_midi');
    expect(joursMai2022).toBe(1); // non exclu → 1 jour ouvré normal

    // Le même 1er mai 2023 ne doit PAS être exclu (non récurrent)
    // 1er mai 2023 = lundi (jour ouvré)
    const joursMai2023 = await calcJoursConges(entreprise.id, '2023-05-01', '2023-05-01', 'matin', 'apres_midi');
    expect(joursMai2023).toBe(1); // non exclu : férié non récurrent, année différente
  });

  it('Période couvrant Noël 2024 : seul Noël est exclu', async () => {
    // 23-27 déc 2024 → lun, mar, mer(Noël), jeu, ven = 5 ouvrés − 1 férié = 4
    const jours = await calcJoursConges(entreprise.id, '2024-12-23', '2024-12-27', 'matin', 'apres_midi');
    expect(jours).toBe(4);
  });
});
