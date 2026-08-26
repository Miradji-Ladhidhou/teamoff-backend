'use strict';
/**
 * rejeterCongeAnnules.test.js — Fix #49
 *
 * rejeterConge libère jours_reserves mais n'incrémente pas jours_annules.
 * Conséquence : le reporting RH sous-estime les congés refusés.
 *
 * AVANT fix : jours_annules reste à 0 après rejet.
 * APRÈS fix  : jours_annules += jours_calcules du congé refusé.
 *
 * Cas testés :
 *   A) Rejet manager  (en_attente_manager → refuse_manager)  → jours_annules incrémenté
 *   B) Rejet admin    (valide_manager → refuse_final)         → jours_annules incrémenté
 *   C) Non-régression : jours_acquis et jours_reserves non affectés par rapport au rejet
 */

const bcrypt = require('bcrypt');
const dayjs  = require('dayjs');
const {
  Entreprise, Utilisateur, CongeType, CompteurConges, Conge,
} = require('../src/models');
const { rejeterConge } = require('../src/services/congesService');

const TS   = Date.now();
const YEAR = dayjs().year();

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

async function mkFixture(label, workflow = 'manager_admin') {
  const hash = await bcrypt.hash('Test1234!', 10);

  const ent = await Entreprise.create({
    nom: `RejAnnules_${label}_${TS}`,
    politique_conges: {
      approval_workflow: workflow,
      blocked_days: { exclude_weekends: false, exclude_holidays: false },
    },
    parametres: {},
    statut: 'active',
  });

  const employe = await Utilisateur.create({
    entreprise_id: ent.id, prenom: 'Emp', nom: `${label}49`,
    email: `emp.${label}.49.${TS}@test.internal`,
    role: 'employe', password_hash: hash, statut: 'actif',
  });
  const manager = await Utilisateur.create({
    entreprise_id: ent.id, prenom: 'Mgr', nom: `${label}49`,
    email: `mgr.${label}.49.${TS}@test.internal`,
    role: 'manager', password_hash: hash, statut: 'actif',
  });
  const admin = await Utilisateur.create({
    entreprise_id: ent.id, prenom: 'Adm', nom: `${label}49`,
    email: `adm.${label}.49.${TS}@test.internal`,
    role: 'admin_entreprise', password_hash: hash, statut: 'actif',
  });

  const congeType = await CongeType.create({
    entreprise_id: ent.id,
    libelle: `CP_${label}_${TS}`,
    code: `RJA${label.slice(0, 2).toUpperCase()}${String(TS).slice(-6)}`,
    deductible: true,
    demi_journee_autorisee: false,
  });

  return { ent, employe, manager, admin, congeType };
}

// ─────────────────────────────────────────────────────────────────────────────
// A) Rejet manager : en_attente_manager → refuse_manager
// ─────────────────────────────────────────────────────────────────────────────

describe('Fix #49 A — rejet manager incrémente jours_annules', () => {
  let ent, employe, manager, congeType, conge, compteur;

  beforeAll(async () => {
    ({ ent, employe, manager, congeType } = await mkFixture('A'));

    compteur = await CompteurConges.create({
      entreprise_id: ent.id,
      utilisateur_id: employe.id,
      conge_type_id: congeType.id,
      annee: YEAR,
      jours_acquis: 10,
      jours_reserves: 5,   // 5j déjà réservés pour ce congé
      jours_pris: 0,
      jours_annules: 0,
    });

    conge = await Conge.create({
      entreprise_id: ent.id,
      utilisateur_id: employe.id,
      conge_type_id: congeType.id,
      date_debut: `${YEAR}-09-01`,
      date_fin:   `${YEAR}-09-05`,
      statut: 'en_attente_manager',
      jours_calcules: 5,
    });
  });

  afterAll(async () => {
    await Conge.destroy({ where: { entreprise_id: ent.id } });
    await CompteurConges.destroy({ where: { entreprise_id: ent.id } });
    await Utilisateur.destroy({ where: { entreprise_id: ent.id } });
    await CongeType.destroy({ where: { entreprise_id: ent.id } });
    await Entreprise.destroy({ where: { id: ent.id } });
  });

  it('jours_annules vaut 5 après rejet manager (était 0)', async () => {
    await rejeterConge(conge.id, manager, 'Pas disponible');

    const cpt = await CompteurConges.findByPk(compteur.id);
    expect(Number(cpt.jours_annules)).toBeCloseTo(5, 5);
  });

  it('jours_reserves revient à 0 après rejet (non-régression)', async () => {
    const cpt = await CompteurConges.findByPk(compteur.id);
    expect(Number(cpt.jours_reserves)).toBeCloseTo(0, 5);
  });

  it('jours_acquis reste inchangé après rejet (non-régression)', async () => {
    const cpt = await CompteurConges.findByPk(compteur.id);
    // Un rejet ne consomme pas jours_acquis
    expect(Number(cpt.jours_acquis)).toBeCloseTo(10, 5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B) Rejet admin : valide_manager → refuse_final
// ─────────────────────────────────────────────────────────────────────────────

describe('Fix #49 B — rejet admin incrémente jours_annules', () => {
  let ent, employe, admin, congeType, conge, compteur;

  beforeAll(async () => {
    ({ ent, employe, admin, congeType } = await mkFixture('B'));

    compteur = await CompteurConges.create({
      entreprise_id: ent.id,
      utilisateur_id: employe.id,
      conge_type_id: congeType.id,
      annee: YEAR,
      jours_acquis: 15,
      jours_reserves: 3,
      jours_pris: 0,
      jours_annules: 2,   // déjà 2 jours annulés précédemment
    });

    conge = await Conge.create({
      entreprise_id: ent.id,
      utilisateur_id: employe.id,
      conge_type_id: congeType.id,
      date_debut: `${YEAR}-10-01`,
      date_fin:   `${YEAR}-10-03`,
      statut: 'valide_manager',
      jours_calcules: 3,
    });
  });

  afterAll(async () => {
    await Conge.destroy({ where: { entreprise_id: ent.id } });
    await CompteurConges.destroy({ where: { entreprise_id: ent.id } });
    await Utilisateur.destroy({ where: { entreprise_id: ent.id } });
    await CongeType.destroy({ where: { entreprise_id: ent.id } });
    await Entreprise.destroy({ where: { id: ent.id } });
  });

  it('jours_annules passe de 2 à 5 après rejet admin (2 préexistants + 3 du rejet)', async () => {
    await rejeterConge(conge.id, admin, 'Rejet final');

    const cpt = await CompteurConges.findByPk(compteur.id);
    expect(Number(cpt.jours_annules)).toBeCloseTo(5, 5);
  });
});
