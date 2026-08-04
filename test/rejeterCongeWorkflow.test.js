'use strict';
/**
 * rejeterCongeWorkflow.test.js
 *
 * Vérifie que rejeterConge respecte le workflow configuré.
 *
 * BUG : en workflow admin_only, un manager peut refuser un congé (statut
 *       passe à 'refuse_manager' irréversible). La validation est correctement
 *       bloquée (validerConge), mais pas le refus.
 *
 * AVANT fix : rejeterConge manager en admin_only → statut refuse_manager → FAIL
 * APRÈS fix  : rejeterConge manager en admin_only → erreur 'admin_only' → PASS
 */

const { Entreprise, Utilisateur, Conge, CongeType, CompteurConges } = require('../src/models');
const { rejeterConge } = require('../src/services/congesService');

let entrepriseAdminOnly, entrepriseManager;
let managerUser, adminUser, employeUser;
let congeType;
let congeAdminOnly, congeManagerWorkflow;

beforeAll(async () => {
  // Entreprise avec workflow admin_only
  entrepriseAdminOnly = await Entreprise.create({
    nom: 'AdminOnlyTest-' + Date.now(),
    politique_conges: { approval_workflow: 'admin_only' },
    parametres: {},
  });

  // Entreprise avec workflow manager_admin (refus manager légal)
  entrepriseManager = await Entreprise.create({
    nom: 'ManagerAdminTest-' + Date.now(),
    politique_conges: { approval_workflow: 'manager_admin' },
    parametres: {},
  });

  managerUser = await Utilisateur.create({
    prenom: 'Manager', nom: 'Reject',
    email: `manager.reject.${Date.now()}@test.local`,
    role: 'manager', password_hash: 'hash', statut: 'actif',
    entreprise_id: entrepriseAdminOnly.id,
  });

  adminUser = await Utilisateur.create({
    prenom: 'Admin', nom: 'Reject',
    email: `admin.reject.${Date.now()}@test.local`,
    role: 'admin_entreprise', password_hash: 'hash', statut: 'actif',
    entreprise_id: entrepriseAdminOnly.id,
  });

  employeUser = await Utilisateur.create({
    prenom: 'Employe', nom: 'Reject',
    email: `employe.reject.${Date.now()}@test.local`,
    role: 'employe', password_hash: 'hash', statut: 'actif',
    entreprise_id: entrepriseAdminOnly.id,
  });

  // code max 20 chars
  const suffix = String(Date.now()).slice(-6);
  congeType = await CongeType.create({
    libelle: 'Congé Test Reject',
    code: 'RJ_' + suffix,
    entreprise_id: entrepriseAdminOnly.id,
  });

  // Compteur pour l'employé (admin_only entreprise)
  await CompteurConges.create({
    entreprise_id: entrepriseAdminOnly.id,
    utilisateur_id: employeUser.id,
    conge_type_id: congeType.id,
    annee: 2025,
    jours_acquis: 25,
    jours_pris: 0,
    jours_reserves: 5,
  });

  // Congé en attente dans workflow admin_only (statut initial = en_attente_manager)
  congeAdminOnly = await Conge.create({
    utilisateur_id: employeUser.id,
    entreprise_id: entrepriseAdminOnly.id,
    conge_type_id: congeType.id,
    date_debut: '2025-09-01',
    date_fin: '2025-09-05',
    debut_demi_journee: 'matin',
    fin_demi_journee: 'apres_midi',
    statut: 'en_attente_manager',
    jours_calcules: 5,
  });
});

afterAll(async () => {
  const cleanup = async (Model, ids) => {
    for (const id of ids.filter(Boolean)) {
      await Model.destroy({ where: { id } }).catch(() => {});
    }
  };
  await cleanup(Conge, [congeAdminOnly?.id, congeManagerWorkflow?.id]);
  await cleanup(CompteurConges, []);
  await CompteurConges.destroy({ where: { utilisateur_id: employeUser?.id } }).catch(() => {});
  await cleanup(CongeType, [congeType?.id]);
  await cleanup(Utilisateur, [managerUser?.id, adminUser?.id, employeUser?.id]);
  await cleanup(Entreprise, [entrepriseAdminOnly?.id, entrepriseManager?.id]);
});

describe('rejeterConge — workflow admin_only', () => {
  it('manager NE PEUT PAS refuser un congé en workflow admin_only', async () => {
    const reqUser = { id: managerUser.id, role: 'manager', entreprise_id: entrepriseAdminOnly.id };
    await expect(
      rejeterConge(congeAdminOnly.id, reqUser, 'refus illégitime')
    ).rejects.toThrow(/admin_only/i);
  });

  it('le congé reste en_attente_manager après tentative de refus manager', async () => {
    await congeAdminOnly.reload();
    expect(congeAdminOnly.statut).toBe('en_attente_manager');
  });

  it('admin_entreprise PEUT refuser le même congé', async () => {
    const reqUser = { id: adminUser.id, role: 'admin_entreprise', entreprise_id: entrepriseAdminOnly.id };
    await expect(
      rejeterConge(congeAdminOnly.id, reqUser, 'refus admin légal')
    ).resolves.toBeDefined();

    await congeAdminOnly.reload();
    expect(congeAdminOnly.statut).toBe('refuse_final');
  });
});

describe('rejeterConge — workflow manager_admin (refus manager légitime)', () => {
  it('manager PEUT refuser un congé en workflow manager_admin', async () => {
    // Créer un congé dans l'entreprise manager_admin
    const empManager = await Utilisateur.create({
      prenom: 'Emp', nom: 'MgrWf',
      email: `emp.mgrwf.${Date.now()}@test.local`,
      role: 'employe', password_hash: 'hash', statut: 'actif',
      entreprise_id: entrepriseManager.id,
    });

    const ctSuffix = String(Date.now()).slice(-6);
    const ctManager = await CongeType.create({
      libelle: 'Type Manager WF',
      code: 'MW_' + ctSuffix,
      entreprise_id: entrepriseManager.id,
    });

    await CompteurConges.create({
      entreprise_id: entrepriseManager.id,
      utilisateur_id: empManager.id,
      conge_type_id: ctManager.id,
      annee: 2025,
      jours_acquis: 25,
      jours_pris: 0,
      jours_reserves: 5,
    });

    const mgrManager = await Utilisateur.create({
      prenom: 'Mgr', nom: 'MgrWf',
      email: `mgr.mgrwf.${Date.now()}@test.local`,
      role: 'manager', password_hash: 'hash', statut: 'actif',
      entreprise_id: entrepriseManager.id,
    });

    congeManagerWorkflow = await Conge.create({
      utilisateur_id: empManager.id,
      entreprise_id: entrepriseManager.id,
      conge_type_id: ctManager.id,
      date_debut: '2025-10-01',
      date_fin: '2025-10-03',
      debut_demi_journee: 'matin',
      fin_demi_journee: 'apres_midi',
      statut: 'en_attente_manager',
      jours_calcules: 3,
    });

    const reqUser = { id: mgrManager.id, role: 'manager', entreprise_id: entrepriseManager.id };
    await expect(
      rejeterConge(congeManagerWorkflow.id, reqUser, 'refus manager légitime')
    ).resolves.toBeDefined();

    await congeManagerWorkflow.reload();
    expect(congeManagerWorkflow.statut).toBe('refuse_manager');

    // Nettoyage
    await Conge.destroy({ where: { id: congeManagerWorkflow.id } }).catch(() => {});
    await CompteurConges.destroy({ where: { utilisateur_id: empManager.id } }).catch(() => {});
    await CongeType.destroy({ where: { id: ctManager.id } }).catch(() => {});
    await Utilisateur.destroy({ where: { id: [empManager.id, mgrManager.id] } }).catch(() => {});
    congeManagerWorkflow = null;
  });
});
