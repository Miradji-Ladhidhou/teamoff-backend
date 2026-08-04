'use strict';
/**
 * validerCongeCapacite.test.js
 *
 * Vérifie que validerConge respecte la limite max_employees_on_leave.global.
 *
 * DEUX BUGS :
 *   A) Branche admin (admin_only) — aucun check de capacité (bug séquentiel pur)
 *      AVANT fix : admin valide conge1 puis conge2 même période → les deux valide_final (bug)
 *      APRÈS fix  : le second appel lève une erreur de capacité
 *
 *   B) Race condition — branche admin en concurrent (Promise.allSettled)
 *      Sans verrou Entreprise, deux validations admin peuvent interleaver avant commit :
 *      T1 lit count=0 → OK ; T2 lit count=0 (T1 pas encore commité) → OK → les deux approuvés.
 *      AVANT fix : fulfilled.length peut être 2 (bug)
 *      APRÈS fix  : exactement 1 succès grâce au verrou d'entreprise
 */

const {
  Entreprise, Utilisateur, Conge, CongeType, CompteurConges,
} = require('../src/models');
const { validerConge } = require('../src/services/congesService');

const suffix = String(Date.now()).slice(-6);

let entreprise;
let admin;
let empA, empB;
let congeType;
let compteurA, compteurB;

beforeAll(async () => {
  entreprise = await Entreprise.create({
    nom: 'CapaciteTest-' + suffix,
    politique_conges: {
      approval_workflow: 'admin_only',         // admin valide directement en_attente → valide_final
      max_employees_on_leave: { global: 1 },   // max 1 personne absente simultanément
    },
    parametres: {},
  });

  admin = await Utilisateur.create({
    prenom: 'Admin', nom: 'Cap',
    email: `admin.cap.${suffix}@test.local`,
    role: 'admin_entreprise', password_hash: 'hash', statut: 'actif',
    entreprise_id: entreprise.id,
  });

  empA = await Utilisateur.create({
    prenom: 'EmpA', nom: 'Cap',
    email: `empa.cap.${suffix}@test.local`,
    role: 'employe', password_hash: 'hash', statut: 'actif',
    service: 'Dev',
    entreprise_id: entreprise.id,
  });

  empB = await Utilisateur.create({
    prenom: 'EmpB', nom: 'Cap',
    email: `empb.cap.${suffix}@test.local`,
    role: 'employe', password_hash: 'hash', statut: 'actif',
    service: 'Dev',
    entreprise_id: entreprise.id,
  });

  congeType = await CongeType.create({
    libelle: 'Congé Cap', code: 'CP_' + suffix,
    entreprise_id: entreprise.id,
  });

  compteurA = await CompteurConges.create({
    entreprise_id: entreprise.id,
    utilisateur_id: empA.id,
    conge_type_id: congeType.id,
    annee: 2025,
    jours_acquis: 20, jours_pris: 0, jours_reserves: 5,
  });

  compteurB = await CompteurConges.create({
    entreprise_id: entreprise.id,
    utilisateur_id: empB.id,
    conge_type_id: congeType.id,
    annee: 2025,
    jours_acquis: 20, jours_pris: 0, jours_reserves: 5,
  });
});

afterAll(async () => {
  await Conge.destroy({ where: { entreprise_id: entreprise.id } }).catch(() => {});
  await CompteurConges.destroy({ where: { entreprise_id: entreprise.id } }).catch(() => {});
  await CongeType.destroy({ where: { id: congeType.id } }).catch(() => {});
  for (const u of [empA, empB, admin]) {
    await Utilisateur.destroy({ where: { id: u.id } }).catch(() => {});
  }
  await Entreprise.destroy({ where: { id: entreprise.id } }).catch(() => {});
});

// Crée un congé en_attente_manager pour empId sur la période commune
async function creerConge(utilisateur_id) {
  return Conge.create({
    utilisateur_id,
    entreprise_id: entreprise.id,
    conge_type_id: congeType.id,
    date_debut: '2025-10-06',
    date_fin:   '2025-10-10',
    debut_demi_journee: 'matin',
    fin_demi_journee:   'apres_midi',
    statut: 'en_attente_manager',
    jours_calcules: 5,
  });
}

const reqAdmin = () => ({ id: admin.id, role: 'admin_entreprise', entreprise_id: entreprise.id });

// Remet les compteurs à leur état initial pour chaque test
async function resetCompteurs() {
  await CompteurConges.update(
    { jours_acquis: 20, jours_pris: 0, jours_reserves: 5 },
    { where: { entreprise_id: entreprise.id } }
  );
}

// ─── Bug A : branche admin sans check de capacité (séquentiel) ──────────────
describe('Bug A — admin ne vérifie pas la capacité (séquentiel)', () => {
  let c1, c2;

  beforeEach(async () => {
    await resetCompteurs();
    // Supprimer les congés des runs précédents
    await Conge.destroy({ where: { entreprise_id: entreprise.id } }).catch(() => {});
    c1 = await creerConge(empA.id);
    c2 = await creerConge(empB.id);
  });

  it('admin peut valider le premier congé (sous la limite)', async () => {
    await expect(validerConge(c1.id, reqAdmin())).resolves.toBeDefined();
  });

  it('admin NE peut PAS valider le second congé quand le premier est déjà valide_final', async () => {
    // Valider c1 d'abord (séquentiel)
    await validerConge(c1.id, reqAdmin());

    // c2 même période : AVANT fix → success (bug), APRÈS fix → erreur capacité
    await expect(validerConge(c2.id, reqAdmin())).rejects.toThrow(
      /capacit|limite|max.*employ|overlap|trop.*absent/i
    );
  });
});

// ─── Bug B : race condition en concurrent (admin_only, Promise.allSettled) ───
describe('Bug B — race condition concurrent (deux admins, même période)', () => {
  it('exactement une seule validation réussit quand deux partent en même temps', async () => {
    await resetCompteurs();
    await Conge.destroy({ where: { entreprise_id: entreprise.id } }).catch(() => {});

    const cA = await creerConge(empA.id);
    const cB = await creerConge(empB.id);

    // Les deux validations démarrent simultanément — sans verrou Entreprise,
    // T1 et T2 peuvent lire count=0 avant que l'autre ne commite (READ COMMITTED).
    const results = await Promise.allSettled([
      validerConge(cA.id, reqAdmin()),
      validerConge(cB.id, reqAdmin()),
    ]);

    const fulfilled = results.filter(r => r.status === 'fulfilled');
    const rejected  = results.filter(r => r.status === 'rejected');

    // AVANT fix : fulfilled.length peut être 2 (les deux lisent count=0, les deux approuvent)
    // APRÈS fix  : exactement 1 (le verrou Entreprise sérialise, le second voit count=1)
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
  });
});
