'use strict';
/**
 * entrepriseAdminAtomic.test.js — Fix #33
 *
 * La création d'une entreprise et de son admin doit être atomique.
 * AVANT fix : deux appels séparés → orphelin si le second échoue.
 * APRÈS fix  : champ `admin` dans le body → transaction unique → rollback complet si l'admin échoue.
 */

const request  = require('supertest');
const bcrypt   = require('bcrypt');
const app      = require('../src/index');
const { Entreprise, Utilisateur } = require('../src/models');
const { generateToken } = require('./helpers/auth');

let superAdmin, tokenSuperAdmin;
let existingUser;    // email déjà utilisé pour provoquer l'échec
let seedEntreprise;  // entreprise fictive nécessaire pour le super_admin (entreprise_id not-null)

const TS = Date.now();
const NOM_ORPHELIN = `OrphelinTest33_${TS}`;
const NOM_ATOMIC   = `AtomicTest33_${TS}`;

beforeAll(async () => {
  const hash = await bcrypt.hash('Test1234!', 10);

  // Entreprise seed — nécessaire uniquement pour satisfaire entreprise_id NOT NULL du modèle.
  // Le super_admin a accès global indépendamment de son entreprise_id.
  seedEntreprise = await Entreprise.create({
    nom: `Seed33_${TS}`, politique_conges: {}, parametres: {}, statut: 'active',
  });

  superAdmin = await Utilisateur.create({
    entreprise_id: seedEntreprise.id,
    prenom: 'Super', nom: 'Admin33',
    email: `super.admin33.${TS}@test.internal`,
    role: 'super_admin', password_hash: hash, statut: 'actif',
  });

  // Un utilisateur dont on réutilisera l'email pour provoquer l'échec
  existingUser = await Utilisateur.create({
    entreprise_id: seedEntreprise.id,
    prenom: 'Existing', nom: 'User33',
    email: `existing.user33.${TS}@test.internal`,
    role: 'employe', password_hash: hash, statut: 'actif',
  });

  tokenSuperAdmin = generateToken(superAdmin);
});

afterAll(async () => {
  // Nettoyage best-effort — ordre : utilisateurs avant entreprises (FK)
  await Utilisateur.destroy({ where: { id: [superAdmin.id, existingUser.id] } }).catch(() => {});
  await Entreprise.destroy({ where: { nom: [NOM_ORPHELIN, NOM_ATOMIC, `Seed33_${TS}`] } }).catch(() => {});
});

describe('Fix #33 — Atomicité création entreprise + admin', () => {

  it('AVANT fix (flux 2 appels) : entreprise orpheline si la création admin échoue', async () => {
    // Étape 1 : créer l'entreprise seule (premier appel)
    const resEnt = await request(app)
      .post('/api/entreprises')
      .set('Authorization', `Bearer ${tokenSuperAdmin}`)
      .send({ nom: NOM_ORPHELIN, statut: 'active' });

    expect(resEnt.status).toBe(201);
    const entrepriseId = resEnt.body.id;

    // Étape 2 : tenter de créer l'admin avec un role invalide (ENUM DB) → doit échouer
    const resUser = await request(app)
      .post('/api/users')
      .set('Authorization', `Bearer ${tokenSuperAdmin}`)
      .send({
        nom: 'Admin', prenom: 'Test',
        email: `orphan.admin33.${Date.now()}@test.internal`,
        role: 'INVALID_ROLE_XXX',   // viole la contrainte ENUM → 500
        entreprise_id: entrepriseId,
      });

    expect(resUser.status).not.toBe(201);

    // L'entreprise est orpheline : elle existe mais sans admin
    const ent = await Entreprise.findByPk(entrepriseId);
    expect(ent).not.toBeNull(); // existe bien

    const adminCount = await Utilisateur.count({
      where: { entreprise_id: entrepriseId, role: 'admin_entreprise' },
    });
    expect(adminCount).toBe(0); // sans admin → orphelin

    // Nettoyage
    await Entreprise.destroy({ where: { id: entrepriseId } });
  });

  it('APRÈS fix : admin avec email doublon → 409, aucune entreprise créée (rollback)', async () => {
    const countBefore = await Entreprise.count({ where: { nom: NOM_ATOMIC } });

    const res = await request(app)
      .post('/api/entreprises')
      .set('Authorization', `Bearer ${tokenSuperAdmin}`)
      .send({
        nom: NOM_ATOMIC,
        statut: 'active',
        admin: {
          email: existingUser.email,  // doublon → doit déclencher rollback
          prenom: 'Admin', nom: 'Test',
        },
      });

    expect(res.status).toBe(409);

    const countAfter = await Entreprise.count({ where: { nom: NOM_ATOMIC } });
    expect(countAfter).toBe(countBefore); // aucune entreprise créée
  });

  it('APRÈS fix : données valides → 201, entreprise ET admin créés atomiquement', async () => {
    const uniqueEmail = `admin.atomic33.${Date.now()}@test.internal`;

    const res = await request(app)
      .post('/api/entreprises')
      .set('Authorization', `Bearer ${tokenSuperAdmin}`)
      .send({
        nom: NOM_ATOMIC,
        statut: 'active',
        admin: { email: uniqueEmail, prenom: 'Atomic', nom: 'Admin' },
      });

    expect(res.status).toBe(201);
    // La réponse doit inclure les deux objets
    expect(res.body.entreprise).toBeDefined();
    expect(res.body.admin).toBeDefined();
    expect(res.body.admin.email).toBe(uniqueEmail);
    expect(res.body.admin.role).toBe('admin_entreprise');

    const entrepriseId = res.body.entreprise.id;
    const adminCount = await Utilisateur.count({
      where: { entreprise_id: entrepriseId, role: 'admin_entreprise' },
    });
    expect(adminCount).toBe(1);

    // Nettoyage
    await Utilisateur.destroy({ where: { entreprise_id: entrepriseId } });
    await Entreprise.destroy({ where: { id: entrepriseId } });
  });
});
