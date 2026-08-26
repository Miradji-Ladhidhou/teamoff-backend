'use strict';
/**
 * adminValidateOverlapRecheck.test.js — Fix #29
 *
 * Scénario : l'employé soumet deux demandes de congé sur la même période.
 * Le manager les valide toutes deux (→ valide_manager).
 * L'admin valide la première sans voir que la seconde est aussi en attente de
 * validation finale sur la même période.
 *
 * AVANT fix : la validation admin #2 de la même période passe → 200 (bug).
 * APRÈS fix  : 409 — chevauchement détecté sur le même employé.
 */

const request  = require('supertest');
const bcrypt   = require('bcrypt');
const app      = require('../src/index');
const {
  Entreprise, Utilisateur, Conge, CongeType, CompteurConges,
} = require('../src/models');
const { generateToken } = require('./helpers/auth');

const PERIOD = { date_debut: '2027-06-01', date_fin: '2027-06-10' };

let entreprise, employe, manager, admin;
let congeTypeA, congeTypeB;
let tokenManager, tokenAdmin;
let congeA, congeB;

beforeAll(async () => {
  const hash = await bcrypt.hash('Test1234!', 10);

  entreprise = await Entreprise.create({
    nom: 'AdminOverlapRecheck ' + Date.now(),
    politique_conges: { approval_workflow: 'manager_admin', overlap_policy: 'block' },
    parametres: {},
    statut: 'active',
  });

  employe = await Utilisateur.create({
    entreprise_id: entreprise.id,
    prenom: 'Emp', nom: 'Overlap29',
    email: `emp.ov29.${Date.now()}@test.internal`,
    role: 'employe', password_hash: hash, statut: 'actif',
  });

  manager = await Utilisateur.create({
    entreprise_id: entreprise.id,
    prenom: 'Mgr', nom: 'Overlap29',
    email: `mgr.ov29.${Date.now()}@test.internal`,
    role: 'manager', password_hash: hash, statut: 'actif',
  });

  admin = await Utilisateur.create({
    entreprise_id: entreprise.id,
    prenom: 'Adm', nom: 'Overlap29',
    email: `adm.ov29.${Date.now()}@test.internal`,
    role: 'admin_entreprise', password_hash: hash, statut: 'actif',
  });

  // Deux types de congé distincts pour que le service accepte deux demandes
  congeTypeA = await CongeType.create({
    entreprise_id: entreprise.id,
    code: 'CP29A', libelle: 'Congés payés A29',
    quota_annuel: 25, demi_journee_autorisee: true,
  });
  congeTypeB = await CongeType.create({
    entreprise_id: entreprise.id,
    code: 'CP29B', libelle: 'Congés payés B29',
    quota_annuel: 25, demi_journee_autorisee: true,
  });

  // Compteurs pour l'employé
  await CompteurConges.create({
    entreprise_id: entreprise.id,
    utilisateur_id: employe.id,
    conge_type_id: congeTypeA.id,
    annee: 2027,
    jours_acquis: 25, jours_pris: 0, jours_reserves: 0, jours_restants: 25,
  });
  await CompteurConges.create({
    entreprise_id: entreprise.id,
    utilisateur_id: employe.id,
    conge_type_id: congeTypeB.id,
    annee: 2027,
    jours_acquis: 25, jours_pris: 0, jours_reserves: 0, jours_restants: 25,
  });

  tokenManager = generateToken(manager);
  tokenAdmin   = generateToken(admin);

  // Créer deux demandes sur la même période (overlap sur même employé)
  congeA = await Conge.create({
    entreprise_id: entreprise.id,
    utilisateur_id: employe.id,
    conge_type_id: congeTypeA.id,
    ...PERIOD,
    debut_demi_journee: 'matin', fin_demi_journee: 'apres_midi',
    statut: 'en_attente_manager',
  });
  congeB = await Conge.create({
    entreprise_id: entreprise.id,
    utilisateur_id: employe.id,
    conge_type_id: congeTypeB.id,
    ...PERIOD,
    debut_demi_journee: 'matin', fin_demi_journee: 'apres_midi',
    statut: 'en_attente_manager',
  });

  // Le manager valide congeA (avec commentaire obligatoire en cas d'overlap)
  const valA = await request(app)
    .post(`/api/conges/${congeA.id}/validate`)
    .set('Authorization', `Bearer ${tokenManager}`)
    .send({ commentaire: 'OK manager - premier congé' });
  // Accepte 200 ou 409 selon overlap_policy ; on force le statut directement si besoin
  if (valA.status !== 200) {
    await congeA.update({ statut: 'valide_manager', commentaire_manager: 'forcé test' });
  }

  // Le manager valide congeB (même chemin)
  const valB = await request(app)
    .post(`/api/conges/${congeB.id}/validate`)
    .set('Authorization', `Bearer ${tokenManager}`)
    .send({ commentaire: 'OK manager - second congé overlap' });
  if (valB.status !== 200) {
    await congeB.update({ statut: 'valide_manager', commentaire_manager: 'forcé test' });
  }

  // Recharger depuis DB
  congeA = await Conge.findByPk(congeA.id);
  congeB = await Conge.findByPk(congeB.id);
});

afterAll(async () => {
  await Conge.destroy({ where: { entreprise_id: entreprise.id } });
  await CompteurConges.destroy({ where: { entreprise_id: entreprise.id } });
  await CongeType.destroy({ where: { entreprise_id: entreprise.id } });
  await Utilisateur.destroy({ where: { entreprise_id: entreprise.id } });
  await Entreprise.destroy({ where: { id: entreprise.id } });
});

describe('Fix #29 — Re-vérification overlap lors de la validation admin', () => {
  it('les deux demandes sont au statut valide_manager avant le test admin', () => {
    expect(congeA.statut).toBe('valide_manager');
    expect(congeB.statut).toBe('valide_manager');
  });

  it("admin valide congeA → 200 (première validation, pas encore de conflit final)", async () => {
    const res = await request(app)
      .post(`/api/conges/${congeA.id}/validate`)
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ commentaire: 'Validation finale A' });

    expect(res.status).toBe(200);
    expect(res.body.statut).toBe('valide_final');

    // Recharger pour la suite
    congeA = await Conge.findByPk(congeA.id);
  });

  it('APRÈS FIX : admin valide congeB (même période, même employé) → 409 conflit détecté', async () => {
    // congeA est déjà valide_final ; congeB chevauche sur le même employé
    const res = await request(app)
      .post(`/api/conges/${congeB.id}/validate`)
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ commentaire: 'Validation finale B' });

    // APRÈS fix : la re-vérification doit détecter le chevauchement → 409
    expect(res.status).toBe(409);

    // congeB ne doit pas avoir changé de statut
    const fresh = await Conge.findByPk(congeB.id);
    expect(fresh.statut).toBe('valide_manager');
  });
});
