'use strict';
/**
 * seed.js — création de données de test réalistes.
 *
 * Crée :
 *  - 1 entreprise active
 *  - 4 utilisateurs (un par rôle) avec statut "actif"
 *  - 1 type de congé
 *  - tokens JWT valides pour chaque utilisateur
 *
 * Usage :
 *   const ctx = await seed();
 *   // ctx.entreprise, ctx.admin, ctx.manager, ctx.employe, ctx.superAdmin
 *   // ctx.tokens.admin, ctx.tokens.manager, ctx.tokens.employe, ctx.tokens.superAdmin
 *   await ctx.cleanup();  // TRUNCATE toutes les tables de test
 */

const bcrypt = require('bcrypt');
const { generateToken } = require('./auth');
const {
  sequelize,
  Entreprise,
  Utilisateur,
  CongeType,
  CompteurConges,
} = require('../../src/models');

const TEST_PASSWORD = 'Test1234!';
const TEST_PASSWORD_HASH = bcrypt.hashSync(TEST_PASSWORD, 10);

async function seed() {
  // 1. Entreprise
  const entreprise = await Entreprise.create({
    nom: 'Entreprise Test',
    politique_conges: {},
    parametres: {},
    statut: 'active',
  });

  // 2. Utilisateurs
  const superAdmin = await Utilisateur.create({
    entreprise_id: entreprise.id,
    prenom: 'Super',
    nom: 'Admin',
    email: `superadmin.${Date.now()}@test.internal`,
    role: 'super_admin',
    password_hash: TEST_PASSWORD_HASH,
    statut: 'actif',
  });

  const admin = await Utilisateur.create({
    entreprise_id: entreprise.id,
    prenom: 'Admin',
    nom: 'Entreprise',
    email: `admin.${Date.now()}@test.internal`,
    role: 'admin_entreprise',
    password_hash: TEST_PASSWORD_HASH,
    statut: 'actif',
  });

  const manager = await Utilisateur.create({
    entreprise_id: entreprise.id,
    prenom: 'Manager',
    nom: 'Test',
    email: `manager.${Date.now()}@test.internal`,
    role: 'manager',
    password_hash: TEST_PASSWORD_HASH,
    statut: 'actif',
  });

  const employe = await Utilisateur.create({
    entreprise_id: entreprise.id,
    prenom: 'Employé',
    nom: 'Test',
    email: `employe.${Date.now()}@test.internal`,
    role: 'employe',
    password_hash: TEST_PASSWORD_HASH,
    statut: 'actif',
  });

  // 3. Type de congé
  const congeType = await CongeType.create({
    entreprise_id: entreprise.id,
    code: 'CP',
    libelle: 'Congés payés',
    quota_annuel: 25,
    demi_journee_autorisee: true,
  });

  // 4. Tokens
  const tokens = {
    superAdmin: generateToken(superAdmin),
    admin:      generateToken(admin),
    manager:    generateToken(manager),
    employe:    generateToken(employe),
  };

  // 5. Cleanup helper
  async function cleanup() {
    // Suppression dans l'ordre FK
    await sequelize.query(
      `DELETE FROM conge            WHERE entreprise_id = '${entreprise.id}'`
    );
    await sequelize.query(
      `DELETE FROM compteur_conges  WHERE entreprise_id = '${entreprise.id}'`
    );
    await sequelize.query(
      `DELETE FROM conge_type       WHERE entreprise_id = '${entreprise.id}'`
    );
    await sequelize.query(
      `DELETE FROM notification     WHERE entreprise_id = '${entreprise.id}'`
    );
    await sequelize.query(
      `DELETE FROM "Absences"       WHERE entreprise_id = '${entreprise.id}'`
    );
    await sequelize.query(
      `DELETE FROM audit_logs       WHERE entreprise_id = '${entreprise.id}'`
    );
    await sequelize.query(
      `DELETE FROM utilisateur      WHERE entreprise_id = '${entreprise.id}'`
    );
    await sequelize.query(
      `DELETE FROM entreprise       WHERE id = '${entreprise.id}'`
    );
  }

  return {
    entreprise,
    superAdmin,
    admin,
    manager,
    employe,
    congeType,
    tokens,
    TEST_PASSWORD,
    cleanup,
  };
}

module.exports = { seed, TEST_PASSWORD };
