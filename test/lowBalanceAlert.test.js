'use strict';
/**
 * lowBalanceAlert.test.js
 *
 * Vérifie que l'alerte "low-balance" est envoyée à l'employé quand son solde
 * restant est ≤ 3 jours, aussi bien lors d'une validation par un manager
 * (branche pré-existante) que lors d'une validation finale par un admin
 * (branche corrigée).
 *
 * Cas testés :
 *   A) Validation ADMIN — solde ≤ 3 après validation → sendLowBalance appelé
 *   B) Validation ADMIN — solde > 3 après validation → sendLowBalance NON appelé
 *   C) Validation MANAGER (workflow manager_only) — solde ≤ 3 → sendLowBalance appelé (non-régression)
 */

const emailService   = require('../src/services/emailService');
const { validerConge } = require('../src/services/congesService');
const {
  Entreprise, Utilisateur, Conge, CongeType, CompteurConges,
} = require('../src/models');

const suffix = String(Date.now()).slice(-6);

// ─── Seeds partagés ──────────────────────────────────────────────────────────

let entAdmin, entManager;
let admin, manager, empAdmin, empManager;
let congeTypeAdmin, congeTypeManager;

beforeAll(async () => {
  // Entreprise workflow admin_only
  entAdmin = await Entreprise.create({
    nom: `LowBal_Admin_${suffix}`,
    politique_conges: {
      approval_workflow: 'admin_only',
      notification_settings: { on_create: false, on_validate: false, on_reject: false },
    },
    parametres: {},
  });

  admin = await Utilisateur.create({
    prenom: 'Admin', nom: 'LowBal',
    email: `admin.lowbal.${suffix}@test.local`,
    role: 'admin_entreprise', password_hash: 'hash', statut: 'actif',
    entreprise_id: entAdmin.id,
  });

  empAdmin = await Utilisateur.create({
    prenom: 'Emp', nom: 'AdminFlow',
    email: `emp.adminflow.${suffix}@test.local`,
    role: 'employe', password_hash: 'hash', statut: 'actif',
    entreprise_id: entAdmin.id,
  });

  congeTypeAdmin = await CongeType.create({
    libelle: 'CP LowBal Admin', code: `CPA_${suffix}`,
    entreprise_id: entAdmin.id,
  });

  // Entreprise workflow manager_only
  entManager = await Entreprise.create({
    nom: `LowBal_Manager_${suffix}`,
    politique_conges: {
      approval_workflow: 'manager_only',
      notification_settings: { on_create: false, on_validate: false, on_reject: false },
    },
    parametres: {},
  });

  manager = await Utilisateur.create({
    prenom: 'Manager', nom: 'LowBal',
    email: `manager.lowbal.${suffix}@test.local`,
    role: 'manager', password_hash: 'hash', statut: 'actif',
    entreprise_id: entManager.id,
  });

  empManager = await Utilisateur.create({
    prenom: 'Emp', nom: 'ManagerFlow',
    email: `emp.managerflow.${suffix}@test.local`,
    role: 'employe', password_hash: 'hash', statut: 'actif',
    entreprise_id: entManager.id,
  });

  congeTypeManager = await CongeType.create({
    libelle: 'CP LowBal Manager', code: `CPM_${suffix}`,
    entreprise_id: entManager.id,
  });
});

afterAll(async () => {
  await Conge.destroy({ where: { entreprise_id: [entAdmin.id, entManager.id] } });
  await CompteurConges.destroy({ where: { entreprise_id: [entAdmin.id, entManager.id] } });
  await CongeType.destroy({ where: { entreprise_id: [entAdmin.id, entManager.id] } });
  await Utilisateur.destroy({ where: { entreprise_id: [entAdmin.id, entManager.id] } });
  await Entreprise.destroy({ where: { id: [entAdmin.id, entManager.id] } });
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function makeConge({ entrepriseId, utilisateurId, congeTypeId, joursCalcuces, statut = 'en_attente_manager' }) {
  const annee = new Date().getFullYear() + 1;
  return Conge.create({
    entreprise_id: entrepriseId,
    utilisateur_id: utilisateurId,
    conge_type_id:  congeTypeId,
    date_debut: `${annee}-03-10`,
    date_fin:   `${annee}-03-${10 + joursCalcuces - 1}`,
    jours_calcules: joursCalcuces,
    statut,
    commentaire_employe: 'test lowbalance',
  });
}

async function makeCompteur({ entrepriseId, utilisateurId, congeTypeId, joursAcquis }) {
  const annee = new Date().getFullYear() + 1;
  return CompteurConges.create({
    entreprise_id: entrepriseId,
    utilisateur_id: utilisateurId,
    conge_type_id:  congeTypeId,
    annee,
    jours_acquis: joursAcquis,
    jours_pris: 0,
    jours_reserves: 0,
  });
}

// ─── CAS A : Admin valide, solde ≤ 3 → alerte envoyée ───────────────────────

describe('CAS A — validation admin, solde ≤ 3 après validation', () => {
  let spy;
  let conge, compteur;

  beforeAll(async () => {
    // 5 jours acquis, congé de 3 jours → 2 restants ≤ 3 → alerte attendue
    conge    = await makeConge({ entrepriseId: entAdmin.id, utilisateurId: empAdmin.id, congeTypeId: congeTypeAdmin.id, joursCalcuces: 3 });
    compteur = await makeCompteur({ entrepriseId: entAdmin.id, utilisateurId: empAdmin.id, congeTypeId: congeTypeAdmin.id, joursAcquis: 5 });
    spy = jest.spyOn(emailService, 'sendLowBalance').mockResolvedValue(undefined);
    await validerConge(conge.id, admin, null, null);
  });

  afterAll(async () => {
    spy.mockRestore();
    await Conge.destroy({ where: { id: conge.id } });
    await CompteurConges.destroy({ where: { id: compteur.id } });
  });

  it('sendLowBalance est appelé une fois', () => {
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('sendLowBalance reçoit l\'employé, le libellé du type et le solde restant', () => {
    const [utilisateur, libelle, solde] = spy.mock.calls[0];
    expect(utilisateur.id).toBe(empAdmin.id);
    expect(typeof libelle).toBe('string');
    expect(solde).toBe(2); // 5 acquis − 3 pris
  });
});

// ─── CAS B : Admin valide, solde > 3 → pas d'alerte ─────────────────────────

describe('CAS B — validation admin, solde > 3 après validation', () => {
  let spy;
  let conge, compteur;

  beforeAll(async () => {
    // 20 jours acquis, congé de 2 jours → 18 restants > 3 → pas d'alerte
    conge    = await makeConge({ entrepriseId: entAdmin.id, utilisateurId: empAdmin.id, congeTypeId: congeTypeAdmin.id, joursCalcuces: 2 });
    compteur = await makeCompteur({ entrepriseId: entAdmin.id, utilisateurId: empAdmin.id, congeTypeId: congeTypeAdmin.id, joursAcquis: 20 });
    spy = jest.spyOn(emailService, 'sendLowBalance').mockResolvedValue(undefined);
    await validerConge(conge.id, admin, null, null);
  });

  afterAll(async () => {
    spy.mockRestore();
    await Conge.destroy({ where: { id: conge.id } });
    await CompteurConges.destroy({ where: { id: compteur.id } });
  });

  it('sendLowBalance n\'est pas appelé', () => {
    expect(spy).not.toHaveBeenCalled();
  });
});

// ─── CAS C : Manager valide (non-régression), solde ≤ 3 → alerte envoyée ────

describe('CAS C — validation manager, solde ≤ 3 après validation (non-régression)', () => {
  let spy;
  let conge, compteur;

  beforeAll(async () => {
    // 4 jours acquis, congé de 2 jours → 2 restants ≤ 3 → alerte attendue
    conge    = await makeConge({ entrepriseId: entManager.id, utilisateurId: empManager.id, congeTypeId: congeTypeManager.id, joursCalcuces: 2 });
    compteur = await makeCompteur({ entrepriseId: entManager.id, utilisateurId: empManager.id, congeTypeId: congeTypeManager.id, joursAcquis: 4 });
    spy = jest.spyOn(emailService, 'sendLowBalance').mockResolvedValue(undefined);
    await validerConge(conge.id, manager, null, null);
  });

  afterAll(async () => {
    spy.mockRestore();
    await Conge.destroy({ where: { id: conge.id } });
    await CompteurConges.destroy({ where: { id: compteur.id } });
  });

  it('sendLowBalance est appelé une fois', () => {
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('solde restant transmis est correct', () => {
    const [, , solde] = spy.mock.calls[0];
    expect(solde).toBe(2); // 4 acquis − 2 pris
  });
});
