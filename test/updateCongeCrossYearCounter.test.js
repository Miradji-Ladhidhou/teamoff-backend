'use strict';

const {
  Entreprise,
  Utilisateur,
  CongeType,
  CompteurConges,
  Conge,
} = require('../src/models');
const { updateConge } = require('../src/services/congesService');

const RUN_ID = Date.now();
const CURRENT_YEAR = new Date().getFullYear();
const NEXT_YEAR = CURRENT_YEAR + 1;

describe('updateConge — demande N+1 imputée sur le compteur courant', () => {
  let entreprise;
  let employe;
  let typeConge;
  let compteurCourant;
  let compteurFutur;
  let conge;

  beforeAll(async () => {
    entreprise = await Entreprise.create({
      nom: `UpdateCrossYear_${RUN_ID}`,
      politique_conges: {
        approval_workflow: 'manager_admin',
        blocked_days: { exclude_weekends: false, exclude_holidays: false },
      },
      parametres: {},
      statut: 'active',
    });
    employe = await Utilisateur.create({
      entreprise_id: entreprise.id,
      prenom: 'Employe',
      nom: `UpdateCrossYear_${RUN_ID}`,
      email: `update.crossyear.${RUN_ID}@test.internal`,
      role: 'employe',
      password_hash: 'test-hash',
      statut: 'actif',
    });
    typeConge = await CongeType.create({
      entreprise_id: entreprise.id,
      libelle: `CP_UpdateCrossYear_${RUN_ID}`,
      code: `UC${String(RUN_ID).slice(-6)}`,
      deductible: true,
      demi_journee_autorisee: false,
    });
    compteurCourant = await CompteurConges.create({
      entreprise_id: entreprise.id,
      utilisateur_id: employe.id,
      conge_type_id: typeConge.id,
      annee: CURRENT_YEAR,
      jours_acquis: 10,
      jours_pris: 0,
      jours_reserves: 5,
    });
    compteurFutur = await CompteurConges.create({
      entreprise_id: entreprise.id,
      utilisateur_id: employe.id,
      conge_type_id: typeConge.id,
      annee: NEXT_YEAR,
      jours_acquis: 0,
      jours_pris: 0,
      jours_reserves: 0,
    });
    conge = await Conge.create({
      entreprise_id: entreprise.id,
      utilisateur_id: employe.id,
      conge_type_id: typeConge.id,
      date_debut: `${NEXT_YEAR}-10-04`,
      date_fin: `${NEXT_YEAR}-10-08`,
      statut: 'en_attente_manager',
      jours_calcules: 5,
      annee_compteur: CURRENT_YEAR,
    });
  });

  afterAll(async () => {
    if (entreprise) {
      await Entreprise.destroy({ where: { id: entreprise.id } }).catch(() => {});
    }
  });

  it('conserve le compteur mémorisé lors d’une modification dans la même année des dates', async () => {
    await updateConge(conge.id, { date_fin: `${NEXT_YEAR}-10-07` }, employe);

    const savedLeave = await Conge.findByPk(conge.id);
    const savedCurrentCounter = await CompteurConges.findByPk(compteurCourant.id);
    const savedFutureCounter = await CompteurConges.findByPk(compteurFutur.id);

    expect(savedLeave.date_fin).toBe(`${NEXT_YEAR}-10-07`);
    expect(savedLeave.annee_compteur).toBe(CURRENT_YEAR);
    expect(Number(savedCurrentCounter.jours_reserves)).toBe(4);
    expect(Number(savedFutureCounter.jours_reserves)).toBe(0);
  });

  it('permet de modifier un congé 2026 sans affecter une réservation 2027', async () => {
    const currentLeave = await Conge.create({
      entreprise_id: entreprise.id,
      utilisateur_id: employe.id,
      conge_type_id: typeConge.id,
      date_debut: `${CURRENT_YEAR}-11-02`,
      date_fin: `${CURRENT_YEAR}-11-05`,
      statut: 'en_attente_manager',
      jours_calcules: 4,
      annee_compteur: CURRENT_YEAR,
    });
    await compteurCourant.update({ jours_acquis: 10, jours_reserves: 9 });
    await compteurFutur.update({ jours_acquis: 0, jours_reserves: 5 });

    await expect(updateConge(
      currentLeave.id,
      { date_fin: `${CURRENT_YEAR}-11-04` },
      employe
    )).resolves.toBeDefined();

    const savedCurrentLeave = await Conge.findByPk(currentLeave.id);
    await compteurCourant.reload();
    await compteurFutur.reload();
    expect(savedCurrentLeave.date_fin).toBe(`${CURRENT_YEAR}-11-04`);
    expect(Number(compteurCourant.jours_reserves)).toBe(8);
    expect(Number(compteurFutur.jours_reserves)).toBe(5);

    await currentLeave.destroy();
  });

  it('permet de modifier une réservation N+1 sans l’activer ni exiger de solde acquis', async () => {
    await compteurFutur.update({ jours_acquis: 0, jours_reserves: 5 });
    const reservation = await Conge.create({
      entreprise_id: entreprise.id,
      utilisateur_id: employe.id,
      conge_type_id: typeConge.id,
      date_debut: `${NEXT_YEAR}-12-01`,
      date_fin: `${NEXT_YEAR}-12-05`,
      statut: 'reserve',
      jours_calcules: 5,
      annee_compteur: NEXT_YEAR,
    });

    await updateConge(reservation.id, { date_fin: `${NEXT_YEAR}-12-04` }, employe);

    const savedReservation = await Conge.findByPk(reservation.id);
    await compteurFutur.reload();
    expect(savedReservation.statut).toBe('reserve');
    expect(savedReservation.date_fin).toBe(`${NEXT_YEAR}-12-04`);
    expect(savedReservation.annee_compteur).toBe(NEXT_YEAR);
    expect(Number(compteurFutur.jours_acquis)).toBe(0);
    expect(Number(compteurFutur.jours_reserves)).toBe(4);

    await reservation.destroy();
  });

  it('transfère la réserve et met à jour annee_compteur si les dates changent d’année', async () => {
    await compteurCourant.update({ jours_acquis: 0, jours_reserves: 5 });
    await compteurFutur.update({ jours_acquis: 0, jours_reserves: 0 });
    const reservation = await Conge.create({
      entreprise_id: entreprise.id,
      utilisateur_id: employe.id,
      conge_type_id: typeConge.id,
      date_debut: `${CURRENT_YEAR}-11-02`,
      date_fin: `${CURRENT_YEAR}-11-06`,
      statut: 'reserve',
      jours_calcules: 5,
      annee_compteur: CURRENT_YEAR,
    });

    await updateConge(reservation.id, {
      date_debut: `${NEXT_YEAR}-12-01`,
      date_fin: `${NEXT_YEAR}-12-05`,
    }, employe);

    const savedReservation = await Conge.findByPk(reservation.id);
    await compteurCourant.reload();
    await compteurFutur.reload();
    expect(savedReservation.statut).toBe('reserve');
    expect(savedReservation.annee_compteur).toBe(NEXT_YEAR);
    expect(Number(compteurCourant.jours_reserves)).toBe(0);
    expect(Number(compteurFutur.jours_reserves)).toBe(5);

    await reservation.destroy();
  });
});