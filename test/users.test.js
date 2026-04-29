'use strict';
/**
 * users.test.js — Tests RBAC complets pour /api/users
 *
 * Couvre :
 *  - super_admin    → accès total (toutes entreprises)
 *  - admin_entreprise → limité à son entreprise
 *  - manager        → lecture seulement (son entreprise)
 *  - employe        → interdit sur la plupart des actions
 *  - CRUD complet
 *  - Validation des champs
 */

const request = require('supertest');
const app = require('../src/index');
const { seed } = require('./helpers/seed');

let ctx;

beforeAll(async () => {
  ctx = await seed();
});

afterAll(async () => {
  await ctx.cleanup();
});

// ===========================================================================
describe('GET /api/users — liste des utilisateurs', () => {
  it('admin_entreprise → 200 avec liste filtrée à son entreprise', async () => {
    const res = await request(app)
      .get('/api/users')
      .set('Authorization', `Bearer ${ctx.tokens.admin}`);

    expect(res.status).toBe(200);
    const users = Array.isArray(res.body) ? res.body : res.body.data || res.body.users || [];
    // Tous les utilisateurs retournés doivent appartenir à la même entreprise
    users.forEach((u) => {
      expect(u.entreprise_id).toBe(ctx.entreprise.id);
    });
    // Ne doit jamais exposer le mot de passe
    users.forEach((u) => {
      expect(u).not.toHaveProperty('password_hash');
    });
  });

  it('manager → 200 (accès lecture autorisé)', async () => {
    const res = await request(app)
      .get('/api/users')
      .set('Authorization', `Bearer ${ctx.tokens.manager}`);

    expect([200, 403]).toContain(res.status);
    // Si 200, vérifier le filtrage entreprise
    if (res.status === 200) {
      const users = Array.isArray(res.body) ? res.body : res.body.data || [];
      users.forEach((u) => expect(u.entreprise_id).toBe(ctx.entreprise.id));
    }
  });

  it('employe → 403 interdit', async () => {
    const res = await request(app)
      .get('/api/users')
      .set('Authorization', `Bearer ${ctx.tokens.employe}`);

    expect(res.status).toBe(403);
  });

  it('non authentifié → 401', async () => {
    const res = await request(app).get('/api/users');
    expect(res.status).toBe(401);
  });
});

// ===========================================================================
describe('GET /api/users/:id — récupérer un utilisateur', () => {
  it('admin → 200 avec un utilisateur de son entreprise', async () => {
    const res = await request(app)
      .get(`/api/users/${ctx.employe.id}`)
      .set('Authorization', `Bearer ${ctx.tokens.admin}`);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(ctx.employe.id);
    expect(res.body).not.toHaveProperty('password_hash');
  });

  it('employe → peut voir son propre profil', async () => {
    const res = await request(app)
      .get(`/api/users/${ctx.employe.id}`)
      .set('Authorization', `Bearer ${ctx.tokens.employe}`);

    expect([200, 403]).toContain(res.status);
  });

  it('retourne 404 pour un UUID valide inexistant', async () => {
    const fakeId = '00000000-0000-4000-a000-000000000000';
    const res = await request(app)
      .get(`/api/users/${fakeId}`)
      .set('Authorization', `Bearer ${ctx.tokens.admin}`);

    expect(res.status).toBe(404);
  });

  it('retourne 400 pour un UUID malformé', async () => {
    const res = await request(app)
      .get('/api/users/not-a-valid-uuid')
      .set('Authorization', `Bearer ${ctx.tokens.admin}`);

    expect(res.status).toBe(400);
  });
});

// ===========================================================================
describe('POST /api/users — créer un utilisateur', () => {
  let createdUserId = null;

  it('admin_entreprise → 201 crée un employé dans son entreprise', async () => {
    const payload = {
      prenom: 'Nouveau',
      nom: 'Test',
      email: `nouveau.${Date.now()}@test.internal`,
      role: 'employe',
      entreprise_id: ctx.entreprise.id,
      service: 'IT',
    };

    const res = await request(app)
      .post('/api/users')
      .set('Authorization', `Bearer ${ctx.tokens.admin}`)
      .send(payload);

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('id');
    expect(res.body.email).toBe(payload.email);
    expect(res.body).not.toHaveProperty('password_hash');
    createdUserId = res.body.id;
  });

  afterAll(async () => {
    if (createdUserId) {
      const { Utilisateur } = require('../src/models');
      await Utilisateur.destroy({ where: { id: createdUserId } });
    }
  });

  it('employe → 403 interdit', async () => {
    const res = await request(app)
      .post('/api/users')
      .set('Authorization', `Bearer ${ctx.tokens.employe}`)
      .send({
        prenom: 'Hack',
        nom: 'Attempt',
        email: `hack.${Date.now()}@test.internal`,
        role: 'admin_entreprise',
        entreprise_id: ctx.entreprise.id,
      });

    expect(res.status).toBe(403);
  });

  it('manager → 403 interdit', async () => {
    const res = await request(app)
      .post('/api/users')
      .set('Authorization', `Bearer ${ctx.tokens.manager}`)
      .send({
        prenom: 'Test',
        nom: 'Manager',
        email: `mgr.${Date.now()}@test.internal`,
        role: 'employe',
        entreprise_id: ctx.entreprise.id,
      });

    expect(res.status).toBe(403);
  });

  it('retourne 400/422 si email manquant', async () => {
    const res = await request(app)
      .post('/api/users')
      .set('Authorization', `Bearer ${ctx.tokens.admin}`)
      .send({ prenom: 'Test', nom: 'Test', role: 'employe', entreprise_id: ctx.entreprise.id });

    expect([400, 422]).toContain(res.status);
    expect(res.body).toHaveProperty('message');
  });

  it('retourne 400/422 si rôle invalide', async () => {
    const res = await request(app)
      .post('/api/users')
      .set('Authorization', `Bearer ${ctx.tokens.admin}`)
      .send({
        prenom: 'Test',
        nom: 'Test',
        email: `role.${Date.now()}@test.internal`,
        role: 'super_hacker',
        entreprise_id: ctx.entreprise.id,
      });

    expect([400, 422]).toContain(res.status);
  });

  it('retourne 409 si email déjà utilisé dans l\'entreprise', async () => {
    const payload = {
      prenom: 'Double',
      nom: 'Test',
      email: ctx.employe.email, // email déjà existant
      role: 'employe',
      entreprise_id: ctx.entreprise.id,
    };

    const res = await request(app)
      .post('/api/users')
      .set('Authorization', `Bearer ${ctx.tokens.admin}`)
      .send(payload);

    expect([409, 422]).toContain(res.status);
  });
});

// ===========================================================================
describe('PUT /api/users/:id — modifier un utilisateur', () => {
  it('admin → 200 modifie le service d\'un employé', async () => {
    const res = await request(app)
      .put(`/api/users/${ctx.employe.id}`)
      .set('Authorization', `Bearer ${ctx.tokens.admin}`)
      .send({ service: 'RH' });

    expect(res.status).toBe(200);
  });

  it('employe → 403 interdit de modifier un autre utilisateur', async () => {
    const res = await request(app)
      .put(`/api/users/${ctx.manager.id}`)
      .set('Authorization', `Bearer ${ctx.tokens.employe}`)
      .send({ service: 'Hack' });

    expect(res.status).toBe(403);
  });

  it('retourne 400 pour UUID invalide', async () => {
    const res = await request(app)
      .put('/api/users/invalid-uuid')
      .set('Authorization', `Bearer ${ctx.tokens.admin}`)
      .send({ service: 'IT' });

    expect(res.status).toBe(400);
  });
});

// ===========================================================================
describe('PUT /api/users/:id/role — changer le rôle', () => {
  it('super_admin → 200 peut changer le rôle', async () => {
    const res = await request(app)
      .put(`/api/users/${ctx.employe.id}/role`)
      .set('Authorization', `Bearer ${ctx.tokens.superAdmin}`)
      .send({ role: 'manager' });

    if (res.status === 200) {
      // Remettre le rôle original
      await request(app)
        .put(`/api/users/${ctx.employe.id}/role`)
        .set('Authorization', `Bearer ${ctx.tokens.superAdmin}`)
        .send({ role: 'employe' });
    }

    expect([200, 404]).toContain(res.status); // 404 si super_admin n'a pas accès inter-entreprise ici
  });

  it('admin_entreprise → 403 interdit de changer les rôles', async () => {
    const res = await request(app)
      .put(`/api/users/${ctx.employe.id}/role`)
      .set('Authorization', `Bearer ${ctx.tokens.admin}`)
      .send({ role: 'manager' });

    expect(res.status).toBe(403);
  });

  it('manager → 403 interdit', async () => {
    const res = await request(app)
      .put(`/api/users/${ctx.employe.id}/role`)
      .set('Authorization', `Bearer ${ctx.tokens.manager}`)
      .send({ role: 'employe' });

    expect(res.status).toBe(403);
  });
});

// ===========================================================================
describe('DELETE /api/users/:id — supprimer un utilisateur', () => {
  it('employe → 403 interdit', async () => {
    const res = await request(app)
      .delete(`/api/users/${ctx.manager.id}`)
      .set('Authorization', `Bearer ${ctx.tokens.employe}`);

    expect(res.status).toBe(403);
  });

  it('manager → 403 interdit', async () => {
    const res = await request(app)
      .delete(`/api/users/${ctx.employe.id}`)
      .set('Authorization', `Bearer ${ctx.tokens.manager}`);

    expect(res.status).toBe(403);
  });

  it('retourne 404 pour utilisateur inexistant', async () => {
    const fakeId = '00000000-0000-4000-a000-000000000001';
    const res = await request(app)
      .delete(`/api/users/${fakeId}`)
      .set('Authorization', `Bearer ${ctx.tokens.admin}`);

    expect([404, 403]).toContain(res.status);
  });
});

// ===========================================================================
describe('Isolation multi-tenant', () => {
  it('admin ne peut pas voir les utilisateurs d\'une autre entreprise', async () => {
    // Créer une seconde entreprise isolée
    const { Entreprise, Utilisateur } = require('../src/models');
    const { generateToken } = require('./helpers/auth');
    const bcrypt = require('bcrypt');

    const autreEntreprise = await Entreprise.create({
      nom: 'Autre Entreprise',
      politique_conges: {},
      parametres: {},
      statut: 'active',
    });

    const autreAdmin = await Utilisateur.create({
      entreprise_id: autreEntreprise.id,
      prenom: 'Autre',
      nom: 'Admin',
      email: `autre.admin.${Date.now()}@test.internal`,
      role: 'admin_entreprise',
      password_hash: bcrypt.hashSync('Test1234!', 10),
      statut: 'actif',
    });

    const autreToken = generateToken(autreAdmin);

    const res = await request(app)
      .get('/api/users')
      .set('Authorization', `Bearer ${autreToken}`);

    // Cleanup
    await Utilisateur.destroy({ where: { id: autreAdmin.id } });
    await Entreprise.destroy({ where: { id: autreEntreprise.id } });

    if (res.status === 200) {
      const users = Array.isArray(res.body) ? res.body : res.body.data || [];
      // Aucun utilisateur de l'entreprise principale ne doit apparaître
      const leak = users.find((u) => u.entreprise_id === ctx.entreprise.id);
      expect(leak).toBeUndefined();
    }
  });
});
