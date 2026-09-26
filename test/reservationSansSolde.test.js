'use strict';
/**
 * reservationSansSolde.test.js — Feature réservation N+1
 *
 * Comportements testés :
 *   A) createConge → statut 'reserve' si solde insuffisant + année N+1 + flag activé
 *   B) createConge → 422 si solde insuffisant + année N+1 + flag désactivé
 *   C) tryActivateReservations → FIFO, solde partiel (seules les premières activées)
 *   D) tryActivateReservations → tout activé si solde couvre tout
 *   E) tryActivateReservations → aucune activation si compteur absent
 *   F) tryActivateReservations → idempotente (appel double n'active pas deux fois)
 */

const bcrypt = require('bcrypt');
const dayjs  = require('dayjs');
const {
  Entreprise, Utilisateur, CongeType, CompteurConges, Conge, CongeImputation,
} = require('../src/models');
const { createConge, tryActivateReservations, validerConge } = require('../src/services/congesService');

const TS        = Date.now();
const NEXT_YEAR = dayjs().year() + 1;

// ─────────────────────────────────────────────────────────────────────────────
// Factory helpers
// ─────────────────────────────────────────────────────────────────────────────

async function mkEntreprise(label, autoriserReservation = true) {
  return Entreprise.create({
    nom: `ResaSansSolde_${label}_${TS}`,
    politique_conges: {
      approval_workflow: 'auto',
      autoriser_reservation_sans_solde: autoriserReservation,
      blocked_days: { exclude_weekends: false, exclude_holidays: false },
    },
    parametres: {},
    statut: 'active',
  });
}

async function mkEmploye(entrepriseId, label) {
  const hash = await bcrypt.hash('Test1234!', 10);
  return Utilisateur.create({
    entreprise_id: entrepriseId,
    prenom: 'Emp', nom: label,
    email: `emp.${label}.${TS}@test.internal`,
    role: 'employe', password_hash: hash, statut: 'actif',
  });
}

async function mkCongeType(entrepriseId, label) {
  return CongeType.create({
    entreprise_id: entrepriseId,
    libelle: `CP_${label}_${TS}`,
    code: `RSA${label.slice(0,2).toUpperCase()}${String(TS).slice(-6)}`,
    deductible: true,
    demi_journee_autorisee: false,
  });
}

async function mkCompteur(entrepriseId, utilisateurId, congeTypeId, annee, opts = {}) {
  return CompteurConges.create({
    entreprise_id: entrepriseId,
    utilisateur_id: utilisateurId,
    conge_type_id: congeTypeId,
    annee,
    jours_acquis:  opts.jours_acquis  ?? 0,
    jours_reserves: opts.jours_reserves ?? 0,
    jours_pris:    opts.jours_pris    ?? 0,
    jours_annules: opts.jours_annules ?? 0,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// A) createConge → réservation si flag=true + N+1 + solde insuffisant
// ─────────────────────────────────────────────────────────────────────────────

describe('Feature N+1 A — createConge crée une réservation si flag activé', () => {
  let ent, emp, type;

  beforeAll(async () => {
    ent  = await mkEntreprise('A', true);
    emp  = await mkEmploye(ent.id, 'A');
    type = await mkCongeType(ent.id, 'A');
    // Compteur N+1 avec solde insuffisant
    await mkCompteur(ent.id, emp.id, type.id, NEXT_YEAR, { jours_acquis: 0, jours_reserves: 0 });
  });

  afterAll(async () => {
    await Conge.destroy({ where: { entreprise_id: ent.id } });
    await CompteurConges.destroy({ where: { entreprise_id: ent.id } });
    await Utilisateur.destroy({ where: { entreprise_id: ent.id } });
    await CongeType.destroy({ where: { entreprise_id: ent.id } });
    await Entreprise.destroy({ where: { id: ent.id } });
  });

  it('crée le congé avec statut=reserve quand solde=0 et année N+1', async () => {
    // createConge exige reqUser.role='employe' ou 'manager' et reqUser.id=utilisateurId
    const conge = await createConge({
      utilisateurId: emp.id,
      conge_type_id: type.id,
      date_debut: `${NEXT_YEAR}-06-02`,
      date_fin:   `${NEXT_YEAR}-06-06`,
      reqUser: emp,
    });

    expect(conge.statut).toBe('reserve');

    // Compteur mis à jour : jours_reserves > 0
    const compteur = await CompteurConges.findOne({
      where: { utilisateur_id: emp.id, conge_type_id: type.id, annee: NEXT_YEAR },
    });
    expect(Number(compteur.jours_reserves)).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B) createConge → 422 si flag=false + N+1 + solde insuffisant
// ─────────────────────────────────────────────────────────────────────────────

describe('Feature N+1 B — createConge rejette si flag désactivé', () => {
  let ent, emp, type;

  beforeAll(async () => {
    ent  = await mkEntreprise('B', false);
    emp  = await mkEmploye(ent.id, 'B');
    type = await mkCongeType(ent.id, 'B');
    await mkCompteur(ent.id, emp.id, type.id, NEXT_YEAR, { jours_acquis: 0 });
  });

  afterAll(async () => {
    await Conge.destroy({ where: { entreprise_id: ent.id } });
    await CompteurConges.destroy({ where: { entreprise_id: ent.id } });
    await Utilisateur.destroy({ where: { entreprise_id: ent.id } });
    await CongeType.destroy({ where: { entreprise_id: ent.id } });
    await Entreprise.destroy({ where: { id: ent.id } });
  });

  it('lance une erreur 422 quand autoriser_reservation_sans_solde=false', async () => {
    await expect(
      createConge({
        utilisateurId: emp.id,
        conge_type_id: type.id,
        date_debut: `${NEXT_YEAR}-07-01`,
        date_fin:   `${NEXT_YEAR}-07-05`,
        reqUser: emp,
      })
    ).rejects.toMatchObject({ status: 422 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C) tryActivateReservations — solde partiel : seule la 1ère réservation activée
// ─────────────────────────────────────────────────────────────────────────────

describe('Feature N+1 C — tryActivateReservations solde partiel (FIFO)', () => {
  let ent, emp, type, conge1, conge2, compteur;

  beforeAll(async () => {
    ent  = await mkEntreprise('C', true);
    emp  = await mkEmploye(ent.id, 'C');
    type = await mkCongeType(ent.id, 'C');

    // Compteur : 5 acquis, 10 réservés (2 réservations de 5j chacune)
    compteur = await mkCompteur(ent.id, emp.id, type.id, NEXT_YEAR, {
      jours_acquis: 5, jours_reserves: 10,
    });

    // Deux réservations FIFO : premiere debut < deuxieme debut
    conge1 = await Conge.create({
      entreprise_id: ent.id, utilisateur_id: emp.id, conge_type_id: type.id,
      date_debut: `${NEXT_YEAR}-03-03`, date_fin: `${NEXT_YEAR}-03-07`,
      statut: 'reserve', jours_calcules: 5,
    });
    conge2 = await Conge.create({
      entreprise_id: ent.id, utilisateur_id: emp.id, conge_type_id: type.id,
      date_debut: `${NEXT_YEAR}-04-07`, date_fin: `${NEXT_YEAR}-04-11`,
      statut: 'reserve', jours_calcules: 5,
    });
  });

  afterAll(async () => {
    await Conge.destroy({ where: { entreprise_id: ent.id } });
    await CompteurConges.destroy({ where: { entreprise_id: ent.id } });
    await Utilisateur.destroy({ where: { entreprise_id: ent.id } });
    await CongeType.destroy({ where: { entreprise_id: ent.id } });
    await Entreprise.destroy({ where: { id: ent.id } });
  });

  it('active la 1ère réservation et laisse la 2ème en attente', async () => {
    const result = await tryActivateReservations(emp.id, type.id, NEXT_YEAR);

    expect(result.error).toBeUndefined();
    expect(result.activated).toHaveLength(1);
    expect(result.still_pending).toHaveLength(1);
    expect(result.activated[0].conge_id).toBe(conge1.id);
    expect(result.still_pending[0].conge_id).toBe(conge2.id);

    const c1 = await Conge.findByPk(conge1.id);
    const c2 = await Conge.findByPk(conge2.id);
    // workflow=auto → valide_final
    expect(c1.statut).toBe('valide_final');
    expect(c2.statut).toBe('reserve');

    const cpt = await CompteurConges.findByPk(compteur.id);
    // Après activation de conge1 : acquis=0, reserves=5 (conge2 reste), pris=5
    expect(Number(cpt.jours_acquis)).toBeCloseTo(0, 5);
    expect(Number(cpt.jours_reserves)).toBeCloseTo(5, 5);
    expect(Number(cpt.jours_pris)).toBeCloseTo(5, 5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D) tryActivateReservations — solde couvre tout
// ─────────────────────────────────────────────────────────────────────────────

describe('Feature N+1 D — tryActivateReservations solde suffisant pour tout', () => {
  let ent, emp, type, conge1, conge2;

  beforeAll(async () => {
    ent  = await mkEntreprise('D', true);
    emp  = await mkEmploye(ent.id, 'D');
    type = await mkCongeType(ent.id, 'D');

    // Compteur avec solde suffisant pour les 2 réservations (10 acquis, 10 reserves)
    await mkCompteur(ent.id, emp.id, type.id, NEXT_YEAR, {
      jours_acquis: 10, jours_reserves: 10,
    });

    conge1 = await Conge.create({
      entreprise_id: ent.id, utilisateur_id: emp.id, conge_type_id: type.id,
      date_debut: `${NEXT_YEAR}-05-05`, date_fin: `${NEXT_YEAR}-05-09`,
      statut: 'reserve', jours_calcules: 5,
    });
    conge2 = await Conge.create({
      entreprise_id: ent.id, utilisateur_id: emp.id, conge_type_id: type.id,
      date_debut: `${NEXT_YEAR}-06-02`, date_fin: `${NEXT_YEAR}-06-06`,
      statut: 'reserve', jours_calcules: 5,
    });
  });

  afterAll(async () => {
    await Conge.destroy({ where: { entreprise_id: ent.id } });
    await CompteurConges.destroy({ where: { entreprise_id: ent.id } });
    await Utilisateur.destroy({ where: { entreprise_id: ent.id } });
    await CongeType.destroy({ where: { entreprise_id: ent.id } });
    await Entreprise.destroy({ where: { id: ent.id } });
  });

  it('active les 2 réservations et vide le solde', async () => {
    const result = await tryActivateReservations(emp.id, type.id, NEXT_YEAR);

    expect(result.activated).toHaveLength(2);
    expect(result.still_pending).toHaveLength(0);

    const c1 = await Conge.findByPk(conge1.id);
    const c2 = await Conge.findByPk(conge2.id);
    expect(c1.statut).toBe('valide_final');
    expect(c2.statut).toBe('valide_final');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E) tryActivateReservations → no-op si compteur absent
// ─────────────────────────────────────────────────────────────────────────────

describe('Feature N+1 E — tryActivateReservations no-op sans compteur', () => {
  let ent, emp, type;

  beforeAll(async () => {
    ent  = await mkEntreprise('E', true);
    emp  = await mkEmploye(ent.id, 'E');
    type = await mkCongeType(ent.id, 'E');
    // Aucun compteur créé intentionnellement
  });

  afterAll(async () => {
    await Utilisateur.destroy({ where: { entreprise_id: ent.id } });
    await CongeType.destroy({ where: { entreprise_id: ent.id } });
    await Entreprise.destroy({ where: { id: ent.id } });
  });

  it('retourne activated=[] et still_pending=[] sans erreur', async () => {
    const result = await tryActivateReservations(emp.id, type.id, NEXT_YEAR);
    expect(result.activated).toHaveLength(0);
    expect(result.still_pending).toHaveLength(0);
    expect(result.error).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// G) tryActivateReservations — R1 trop grande (skip), R2 plus petite → s'active
//    Confirme que `continue` est utilisé (pas `break`) : R2 n'est pas bloquée
//    par l'échec de R1.
// ─────────────────────────────────────────────────────────────────────────────

describe('Feature N+1 G — R1 skip (trop grande), R2 activée (tient dans le budget)', () => {
  let ent, emp, type, conge1, conge2;

  beforeAll(async () => {
    ent  = await mkEntreprise('G', true);
    emp  = await mkEmploye(ent.id, 'G');
    type = await mkCongeType(ent.id, 'G');

    // acquis=3, reserves=8 (R1=5j trop grand, R2=3j juste suffisant)
    await mkCompteur(ent.id, emp.id, type.id, NEXT_YEAR, {
      jours_acquis: 3, jours_reserves: 8,
    });

    // R1 plus ancienne (sera traitée en premier) — 5j, ne peut pas s'activer avec budget=3
    conge1 = await Conge.create({
      entreprise_id: ent.id, utilisateur_id: emp.id, conge_type_id: type.id,
      date_debut: `${NEXT_YEAR}-02-02`, date_fin: `${NEXT_YEAR}-02-06`,
      statut: 'reserve', jours_calcules: 5,
    });
    // R2 plus récente — 3j, s'active car budget=3 n'a pas été consommé par R1
    conge2 = await Conge.create({
      entreprise_id: ent.id, utilisateur_id: emp.id, conge_type_id: type.id,
      date_debut: `${NEXT_YEAR}-03-03`, date_fin: `${NEXT_YEAR}-03-05`,
      statut: 'reserve', jours_calcules: 3,
    });
  });

  afterAll(async () => {
    await Conge.destroy({ where: { entreprise_id: ent.id } });
    await CompteurConges.destroy({ where: { entreprise_id: ent.id } });
    await Utilisateur.destroy({ where: { entreprise_id: ent.id } });
    await CongeType.destroy({ where: { entreprise_id: ent.id } });
    await Entreprise.destroy({ where: { id: ent.id } });
  });

  it("R1 reste en attente, R2 s'active malgre l'echec de R1", async () => {
    const result = await tryActivateReservations(emp.id, type.id, NEXT_YEAR);

    expect(result.still_pending).toHaveLength(1);
    expect(result.still_pending[0].conge_id).toBe(conge1.id);
    expect(result.activated).toHaveLength(1);
    expect(result.activated[0].conge_id).toBe(conge2.id);

    const c1 = await Conge.findByPk(conge1.id);
    const c2 = await Conge.findByPk(conge2.id);
    expect(c1.statut).toBe('reserve');
    expect(c2.statut).toBe('valide_final');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// F) tryActivateReservations → idempotente
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// H) createConge → manager peut réserver N+1 sans solde (même logique qu'employe)
// ─────────────────────────────────────────────────────────────────────────────

describe('Feature N+1 H — manager peut réserver N+1 sans solde', () => {
  let ent, manager, type;

  beforeAll(async () => {
    const hash = await bcrypt.hash('Test1234!', 10);
    ent  = await mkEntreprise('H', true);
    manager = await Utilisateur.create({
      entreprise_id: ent.id,
      prenom: 'Man', nom: `H_${TS}`,
      email: `manager.H.${TS}@test.internal`,
      role: 'manager', password_hash: hash, statut: 'actif',
    });
    type = await mkCongeType(ent.id, 'H');
    await mkCompteur(ent.id, manager.id, type.id, NEXT_YEAR, { jours_acquis: 0, jours_reserves: 0 });
  });

  afterAll(async () => {
    await Conge.destroy({ where: { entreprise_id: ent.id } });
    await CompteurConges.destroy({ where: { entreprise_id: ent.id } });
    await Utilisateur.destroy({ where: { entreprise_id: ent.id } });
    await CongeType.destroy({ where: { entreprise_id: ent.id } });
    await Entreprise.destroy({ where: { id: ent.id } });
  });

  it('crée le congé avec statut=reserve pour un manager avec solde=0 et année N+1', async () => {
    const conge = await createConge({
      conge_type_id: type.id,
      date_debut: `${NEXT_YEAR}-08-04`,
      date_fin:   `${NEXT_YEAR}-08-08`,
      reqUser: manager,
    });

    expect(conge.statut).toBe('reserve');

    const compteur = await CompteurConges.findOne({
      where: { utilisateur_id: manager.id, conge_type_id: type.id, annee: NEXT_YEAR },
    });
    expect(Number(compteur.jours_reserves)).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// F) tryActivateReservations → idempotente
// ─────────────────────────────────────────────────────────────────────────────

describe('Feature N+1 F — tryActivateReservations idempotente', () => {
  let ent, emp, type, conge;

  beforeAll(async () => {
    ent  = await mkEntreprise('F', true);
    emp  = await mkEmploye(ent.id, 'F');
    type = await mkCongeType(ent.id, 'F');

    await mkCompteur(ent.id, emp.id, type.id, NEXT_YEAR, {
      jours_acquis: 5, jours_reserves: 5,
    });

    conge = await Conge.create({
      entreprise_id: ent.id, utilisateur_id: emp.id, conge_type_id: type.id,
      date_debut: `${NEXT_YEAR}-09-01`, date_fin: `${NEXT_YEAR}-09-05`,
      statut: 'reserve', jours_calcules: 5,
    });
  });

  afterAll(async () => {
    await Conge.destroy({ where: { entreprise_id: ent.id } });
    await CompteurConges.destroy({ where: { entreprise_id: ent.id } });
    await Utilisateur.destroy({ where: { entreprise_id: ent.id } });
    await CongeType.destroy({ where: { entreprise_id: ent.id } });
    await Entreprise.destroy({ where: { id: ent.id } });
  });

  it('2ème appel retourne activated=[] car la réservation est déjà active', async () => {
    const r1 = await tryActivateReservations(emp.id, type.id, NEXT_YEAR);
    expect(r1.activated).toHaveLength(1);

    const r2 = await tryActivateReservations(emp.id, type.id, NEXT_YEAR);
    expect(r2.activated).toHaveLength(0);
    expect(r2.still_pending).toHaveLength(0);

    const c = await Conge.findByPk(conge.id);
    expect(c.statut).toBe('valide_final');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// I) réservation N+1 imputée sur le compteur N
// ─────────────────────────────────────────────────────────────────────────────

describe('Feature N+1 I — activation utilise le compteur mémorisé', () => {
  let ent, emp, type, conge;

  beforeAll(async () => {
    ent  = await mkEntreprise('I', true);
    emp  = await mkEmploye(ent.id, 'I');
    type = await mkCongeType(ent.id, 'I');

    await mkCompteur(ent.id, emp.id, type.id, NEXT_YEAR - 1, {
      jours_acquis: 12, jours_reserves: 12,
    });
    await mkCompteur(ent.id, emp.id, type.id, NEXT_YEAR, {
      jours_acquis: 0, jours_reserves: 0,
    });

    conge = await Conge.create({
      entreprise_id: ent.id, utilisateur_id: emp.id, conge_type_id: type.id,
      date_debut: `${NEXT_YEAR}-11-02`, date_fin: `${NEXT_YEAR}-11-13`,
      statut: 'reserve', jours_calcules: 12, annee_compteur: NEXT_YEAR - 1,
    });
  });

  afterAll(async () => {
    await Conge.destroy({ where: { entreprise_id: ent.id } });
    await CompteurConges.destroy({ where: { entreprise_id: ent.id } });
    await Utilisateur.destroy({ where: { entreprise_id: ent.id } });
    await CongeType.destroy({ where: { entreprise_id: ent.id } });
    await Entreprise.destroy({ where: { id: ent.id } });
  });

  it('active la réservation sur le compteur mémorisé et non sur l’année du congé', async () => {
    const result = await tryActivateReservations(emp.id, type.id, NEXT_YEAR - 1);

    expect(result.activated.map((item) => item.conge_id)).toContain(conge.id);

    const previousYearCounter = await CompteurConges.findOne({
      where: { utilisateur_id: emp.id, conge_type_id: type.id, annee: NEXT_YEAR - 1 },
    });
    const nextYearCounter = await CompteurConges.findOne({
      where: { utilisateur_id: emp.id, conge_type_id: type.id, annee: NEXT_YEAR },
    });

    expect(Number(previousYearCounter.jours_acquis)).toBe(0);
    expect(Number(previousYearCounter.jours_reserves)).toBe(0);
    expect(Number(previousYearCounter.jours_pris)).toBe(12);
    expect(Number(nextYearCounter.jours_acquis)).toBe(0);
    expect(Number(nextYearCounter.jours_pris)).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// J) réservation N+1 activée puis validée sur le solde courant
// ─────────────────────────────────────────────────────────────────────────────

describe('Feature N+1 J — validation finale réalloue vers le solde courant', () => {
  let ent, emp, manager, type, conge;

  beforeAll(async () => {
    const hash = await bcrypt.hash('Test1234!', 10);
    ent = await Entreprise.create({
      nom: `ResaSansSolde_J_${TS}`,
      politique_conges: {
        approval_workflow: 'manager_only',
        autoriser_reservation_sans_solde: true,
        blocked_days: { exclude_weekends: false, exclude_holidays: false },
      },
      parametres: {}, statut: 'active',
    });
    emp = await mkEmploye(ent.id, 'J');
    manager = await Utilisateur.create({
      entreprise_id: ent.id, prenom: 'Manager', nom: `J_${TS}`,
      email: `manager.J.${TS}@test.internal`, role: 'manager', password_hash: hash, statut: 'actif',
    });
    type = await mkCongeType(ent.id, 'J');

    await mkCompteur(ent.id, emp.id, type.id, NEXT_YEAR - 1, { jours_acquis: 12 });
    await mkCompteur(ent.id, emp.id, type.id, NEXT_YEAR, { jours_acquis: 0, jours_reserves: 12 });
    conge = await Conge.create({
      entreprise_id: ent.id, utilisateur_id: emp.id, conge_type_id: type.id,
      date_debut: `${NEXT_YEAR}-07-05`, date_fin: `${NEXT_YEAR}-07-16`,
      statut: 'en_attente_manager', jours_calcules: 12, annee_compteur: NEXT_YEAR,
    });
  });

  afterAll(async () => {
    await Conge.destroy({ where: { entreprise_id: ent.id } });
    await CompteurConges.destroy({ where: { entreprise_id: ent.id } });
    await Utilisateur.destroy({ where: { entreprise_id: ent.id } });
    await CongeType.destroy({ where: { entreprise_id: ent.id } });
    await Entreprise.destroy({ where: { id: ent.id } });
  });

  it('débite 2026, libère la réservation 2027 et trace l’imputation', async () => {
    await validerConge(conge.id, manager, 'Validation sur le solde courant');

    const counter2026 = await CompteurConges.findOne({
      where: { utilisateur_id: emp.id, conge_type_id: type.id, annee: NEXT_YEAR - 1 },
    });
    const counter2027 = await CompteurConges.findOne({
      where: { utilisateur_id: emp.id, conge_type_id: type.id, annee: NEXT_YEAR },
    });
    const imputation = await CongeImputation.findAll({ where: { conge_id: conge.id } });

    expect(Number(counter2026.jours_acquis)).toBe(0);
    expect(Number(counter2026.jours_pris)).toBe(12);
    expect(Number(counter2027.jours_acquis)).toBe(0);
    expect(Number(counter2027.jours_pris)).toBe(0);
    expect(Number(counter2027.jours_reserves)).toBe(0);
    expect(imputation).toHaveLength(1);
    expect(imputation[0].annee).toBe(NEXT_YEAR - 1);
    expect(Number(imputation[0].jours)).toBe(12);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// K) validation finale refusée si le solde réel est insuffisant
// ─────────────────────────────────────────────────────────────────────────────

describe('Feature N+1 K — validation finale atomique si solde insuffisant', () => {
  let ent, emp, manager, type, conge;

  beforeAll(async () => {
    const hash = await bcrypt.hash('Test1234!', 10);
    ent = await Entreprise.create({
      nom: `ResaSansSolde_K_${TS}`,
      politique_conges: {
        approval_workflow: 'manager_only',
        autoriser_reservation_sans_solde: true,
        blocked_days: { exclude_weekends: false, exclude_holidays: false },
      },
      parametres: {}, statut: 'active',
    });
    emp = await mkEmploye(ent.id, 'K');
    manager = await Utilisateur.create({
      entreprise_id: ent.id, prenom: 'Manager', nom: `K_${TS}`,
      email: `manager.K.${TS}@test.internal`, role: 'manager', password_hash: hash, statut: 'actif',
    });
    type = await mkCongeType(ent.id, 'K');
    await mkCompteur(ent.id, emp.id, type.id, NEXT_YEAR - 1, { jours_acquis: 11.5 });
    await mkCompteur(ent.id, emp.id, type.id, NEXT_YEAR, { jours_acquis: 0, jours_reserves: 12 });
    conge = await Conge.create({
      entreprise_id: ent.id, utilisateur_id: emp.id, conge_type_id: type.id,
      date_debut: `${NEXT_YEAR}-08-03`, date_fin: `${NEXT_YEAR}-08-14`,
      statut: 'en_attente_manager', jours_calcules: 12, annee_compteur: NEXT_YEAR,
    });
  });

  afterAll(async () => {
    await Conge.destroy({ where: { entreprise_id: ent.id } });
    await CompteurConges.destroy({ where: { entreprise_id: ent.id } });
    await Utilisateur.destroy({ where: { entreprise_id: ent.id } });
    await CongeType.destroy({ where: { entreprise_id: ent.id } });
    await Entreprise.destroy({ where: { id: ent.id } });
  });

  it('refuse sans modifier le statut ni les compteurs', async () => {
    await expect(validerConge(conge.id, manager, 'Validation impossible')).rejects.toMatchObject({ statusCode: 422 });

    const savedConge = await Conge.findByPk(conge.id);
    const counter2026 = await CompteurConges.findOne({
      where: { utilisateur_id: emp.id, conge_type_id: type.id, annee: NEXT_YEAR - 1 },
    });
    const counter2027 = await CompteurConges.findOne({
      where: { utilisateur_id: emp.id, conge_type_id: type.id, annee: NEXT_YEAR },
    });

    expect(savedConge.statut).toBe('en_attente_manager');
    expect(Number(counter2026.jours_acquis)).toBe(11.5);
    expect(Number(counter2027.jours_reserves)).toBe(12);
    expect(Number(counter2027.jours_pris)).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// L) validation répartie sur plusieurs années sans réserve comptable N+1
// ─────────────────────────────────────────────────────────────────────────────

describe('Feature N+1 L — validation multi-années sans compteur source réservé', () => {
  let ent, emp, manager, type, conge;

  beforeAll(async () => {
    const hash = await bcrypt.hash('Test1234!', 10);
    ent = await Entreprise.create({
      nom: `ResaSansSolde_L_${TS}`,
      politique_conges: {
        approval_workflow: 'manager_only',
        autoriser_reservation_sans_solde: true,
        blocked_days: { exclude_weekends: false, exclude_holidays: false },
      },
      parametres: {}, statut: 'active',
    });
    emp = await mkEmploye(ent.id, 'L');
    manager = await Utilisateur.create({
      entreprise_id: ent.id, prenom: 'Manager', nom: `L_${TS}`,
      email: `manager.L.${TS}@test.internal`, role: 'manager', password_hash: hash, statut: 'actif',
    });
    type = await mkCongeType(ent.id, 'L');
    await mkCompteur(ent.id, emp.id, type.id, NEXT_YEAR - 1, { jours_acquis: 9 });
    await mkCompteur(ent.id, emp.id, type.id, NEXT_YEAR, { jours_acquis: 2 });
    conge = await Conge.create({
      entreprise_id: ent.id, utilisateur_id: emp.id, conge_type_id: type.id,
      date_debut: `${NEXT_YEAR}-05-04`, date_fin: `${NEXT_YEAR}-05-19`,
      statut: 'en_attente_manager', jours_calcules: 11, annee_compteur: null,
    });
  });

  afterAll(async () => {
    await Conge.destroy({ where: { entreprise_id: ent.id } });
    await CongeImputation.destroy({ where: { conge_id: conge?.id } });
    await CompteurConges.destroy({ where: { entreprise_id: ent.id } });
    await Utilisateur.destroy({ where: { entreprise_id: ent.id } });
    await CongeType.destroy({ where: { entreprise_id: ent.id } });
    await Entreprise.destroy({ where: { id: ent.id } });
  });

  it('consomme 9 jours sur l’ancien compteur puis 2 sur N+1', async () => {
    await validerConge(conge.id, manager, 'Validation sur les soldes disponibles');

    const counter2026 = await CompteurConges.findOne({
      where: { utilisateur_id: emp.id, conge_type_id: type.id, annee: NEXT_YEAR - 1 },
    });
    const counter2027 = await CompteurConges.findOne({
      where: { utilisateur_id: emp.id, conge_type_id: type.id, annee: NEXT_YEAR },
    });
    const imputations = await CongeImputation.findAll({
      where: { conge_id: conge.id },
      order: [['annee', 'ASC']],
    });

    const savedConge = await Conge.findByPk(conge.id);
    expect(savedConge.statut).toBe('valide_final');
    expect(Number(counter2026.jours_acquis)).toBe(0);
    expect(Number(counter2026.jours_pris)).toBe(9);
    expect(Number(counter2027.jours_acquis)).toBe(0);
    expect(Number(counter2027.jours_pris)).toBe(2);
    expect(imputations.map((row) => [row.annee, Number(row.jours)])).toEqual([
      [NEXT_YEAR - 1, 9],
      [NEXT_YEAR, 2],
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// M) activation automatique après crédit sans compteur N+1
// ─────────────────────────────────────────────────────────────────────────────

describe('Feature N+1 M — activation automatique avec soldes antérieurs', () => {
  let ent, emp, type, conge;

  beforeAll(async () => {
    ent = await mkEntreprise('M', true);
    emp = await mkEmploye(ent.id, 'M');
    type = await mkCongeType(ent.id, 'M');
    await mkCompteur(ent.id, emp.id, type.id, NEXT_YEAR - 2, { jours_acquis: 3 });
    await mkCompteur(ent.id, emp.id, type.id, NEXT_YEAR - 1, { jours_acquis: 2 });
    conge = await Conge.create({
      entreprise_id: ent.id, utilisateur_id: emp.id, conge_type_id: type.id,
      date_debut: `${NEXT_YEAR}-10-05`, date_fin: `${NEXT_YEAR}-10-09`,
      statut: 'reserve', jours_calcules: 5, annee_compteur: null,
    });
  });

  afterAll(async () => {
    await CongeImputation.destroy({ where: { conge_id: conge?.id } });
    await Conge.destroy({ where: { entreprise_id: ent.id } });
    await CompteurConges.destroy({ where: { entreprise_id: ent.id } });
    await Utilisateur.destroy({ where: { entreprise_id: ent.id } });
    await CongeType.destroy({ where: { entreprise_id: ent.id } });
    await Entreprise.destroy({ where: { id: ent.id } });
  });

  it('valide et impute sur les soldes les plus anciens sans compteur N+1', async () => {
    const result = await tryActivateReservations(emp.id, type.id, NEXT_YEAR);
    const savedConge = await Conge.findByPk(conge.id);
    const counters = await CompteurConges.findAll({
      where: { utilisateur_id: emp.id },
      order: [['annee', 'ASC']],
    });
    const imputations = await CongeImputation.findAll({
      where: { conge_id: conge.id },
      order: [['annee', 'ASC']],
    });

    expect(result.activated).toHaveLength(1);
    expect(savedConge.statut).toBe('valide_final');
    expect(counters.map((row) => Number(row.jours_pris))).toEqual([3, 2]);
    expect(imputations.map((row) => [row.annee, Number(row.jours)])).toEqual([
      [NEXT_YEAR - 2, 3],
      [NEXT_YEAR - 1, 2],
    ]);
    expect(await CompteurConges.count({ where: { utilisateur_id: emp.id, annee: NEXT_YEAR } })).toBe(0);
  });
});
