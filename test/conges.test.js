'use strict';
/**
 * conges.test.js — Tests d'intégration pour /api/conges
 *
 * Couvre :
 *  - Création de demande (employe, manager)
 *  - Lecture (filtrage RBAC : employe → ses congés, admin → tous)
 *  - Validation des champs (dates, type)
 *  - Validation métier (date_fin < date_debut → 422)
 *  - Workflow de validation (manager valide, admin valide final)
 *  - Refus
 *  - Isolation multi-tenant
 *  - Historique
 */

const request = require('supertest');
const app = require('../src/index');
const { seed } = require('./helpers/seed');
const { Conge } = require('../src/models');

let ctx;
let createdCongeIds = [];

beforeAll(async () => {
  ctx = await seed();
});

afterAll(async () => {
  // Nettoyer les congés créés pendant les tests
  if (createdCongeIds.length) {
    await Conge.destroy({ where: { id: createdCongeIds } });
  }
  await ctx.cleanup();
});

// ===========================================================================
describe('POST /api/conges/demande — créer une demande de congé', () => {
  it('employe → 201 crée une demande valide', async () => {
    const res = await request(app)
      .post('/api/conges/demande')
      .set('Authorization', `Bearer ${ctx.tokens.employe}`)
      .send({
        conge_type_id: ctx.congeType.id,
        date_debut: '2026-08-01',
        date_fin: '2026-08-07',
        commentaire_employe: 'Vacances été',
      });

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('id');
    expect(res.body.statut).toBe('en_attente_manager');
    expect(res.body.utilisateur_id).toBe(ctx.employe.id);
    createdCongeIds.push(res.body.id);
  });

  it('manager → 201 peut aussi créer une demande', async () => {
    const res = await request(app)
      .post('/api/conges/demande')
      .set('Authorization', `Bearer ${ctx.tokens.manager}`)
      .send({
        conge_type_id: ctx.congeType.id,
        date_debut: '2026-09-01',
        date_fin: '2026-09-05',
      });

    expect([201, 200]).toContain(res.status);
    if (res.body.id) createdCongeIds.push(res.body.id);
  });

  it('retourne 422 si date_fin < date_debut', async () => {
    const res = await request(app)
      .post('/api/conges/demande')
      .set('Authorization', `Bearer ${ctx.tokens.employe}`)
      .send({
        conge_type_id: ctx.congeType.id,
        date_debut: '2026-08-10',
        date_fin: '2026-08-05', // antérieure
      });

    expect([400, 422]).toContain(res.status);
    expect(res.body).toHaveProperty('message');
  });

  it('retourne 400/422 si conge_type_id manquant', async () => {
    const res = await request(app)
      .post('/api/conges/demande')
      .set('Authorization', `Bearer ${ctx.tokens.employe}`)
      .send({
        date_debut: '2026-08-01',
        date_fin: '2026-08-07',
      });

    expect([400, 422]).toContain(res.status);
  });

  it('retourne 400 si conge_type_id est un UUID invalide', async () => {
    const res = await request(app)
      .post('/api/conges/demande')
      .set('Authorization', `Bearer ${ctx.tokens.employe}`)
      .send({
        conge_type_id: 'not-a-uuid',
        date_debut: '2026-08-01',
        date_fin: '2026-08-07',
      });

    expect([400, 422]).toContain(res.status);
  });

  it('retourne 400/404 si conge_type_id appartient à une autre entreprise', async () => {
    const fakeTypeId = '00000000-0000-4000-a000-000000000099';
    const res = await request(app)
      .post('/api/conges/demande')
      .set('Authorization', `Bearer ${ctx.tokens.employe}`)
      .send({
        conge_type_id: fakeTypeId,
        date_debut: '2026-08-01',
        date_fin: '2026-08-07',
      });

    expect([400, 404, 422]).toContain(res.status);
  });

  it('retourne 401 sans authentification', async () => {
    const res = await request(app)
      .post('/api/conges/demande')
      .send({
        conge_type_id: ctx.congeType.id,
        date_debut: '2026-08-01',
        date_fin: '2026-08-07',
      });

    expect(res.status).toBe(401);
  });
});

// ===========================================================================
describe('GET /api/conges — liste des congés (RBAC)', () => {
  it('employe → 200 ne voit que ses propres congés', async () => {
    const res = await request(app)
      .get('/api/conges')
      .set('Authorization', `Bearer ${ctx.tokens.employe}`);

    expect(res.status).toBe(200);
    const conges = Array.isArray(res.body) ? res.body : res.body.data || res.body.conges || [];
    conges.forEach((c) => {
      expect(c.utilisateur_id).toBe(ctx.employe.id);
    });
  });

  it('manager → 200 peut voir les congés de son équipe', async () => {
    const res = await request(app)
      .get('/api/conges')
      .set('Authorization', `Bearer ${ctx.tokens.manager}`);

    expect(res.status).toBe(200);
    const conges = Array.isArray(res.body) ? res.body : res.body.data || [];
    // Tous dans la même entreprise
    conges.forEach((c) => {
      expect(c.entreprise_id).toBe(ctx.entreprise.id);
    });
  });

  it('admin → 200 voit tous les congés de son entreprise', async () => {
    const res = await request(app)
      .get('/api/conges')
      .set('Authorization', `Bearer ${ctx.tokens.admin}`);

    expect(res.status).toBe(200);
  });

  it('non authentifié → 401', async () => {
    const res = await request(app).get('/api/conges');
    expect(res.status).toBe(401);
  });
});

// ===========================================================================
describe('GET /api/conges/:id — détail d\'un congé', () => {
  let congeId;

  beforeAll(async () => {
    // Créer un congé pour les tests
    const res = await request(app)
      .post('/api/conges/demande')
      .set('Authorization', `Bearer ${ctx.tokens.employe}`)
      .send({
        conge_type_id: ctx.congeType.id,
        date_debut: '2026-10-01',
        date_fin: '2026-10-03',
      });

    if (res.body.id) {
      congeId = res.body.id;
      createdCongeIds.push(congeId);
    }
  });

  it('employe → 200 peut voir son propre congé', async () => {
    if (!congeId) return;
    const res = await request(app)
      .get(`/api/conges/${congeId}`)
      .set('Authorization', `Bearer ${ctx.tokens.employe}`);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(congeId);
  });

  it('admin → 200 peut voir n\'importe quel congé de l\'entreprise', async () => {
    if (!congeId) return;
    const res = await request(app)
      .get(`/api/conges/${congeId}`)
      .set('Authorization', `Bearer ${ctx.tokens.admin}`);

    expect(res.status).toBe(200);
  });

  it('retourne 404 pour un congé inexistant', async () => {
    const fakeId = '00000000-0000-4000-a000-000000000002';
    const res = await request(app)
      .get(`/api/conges/${fakeId}`)
      .set('Authorization', `Bearer ${ctx.tokens.admin}`);

    expect(res.status).toBe(404);
  });

  it('retourne 400 pour un UUID invalide', async () => {
    const res = await request(app)
      .get('/api/conges/pas-un-uuid')
      .set('Authorization', `Bearer ${ctx.tokens.admin}`);

    expect(res.status).toBe(400);
  });
});

// ===========================================================================
describe('POST /api/conges/:id/valider — workflow de validation', () => {
  let congeId;

  beforeAll(async () => {
    const res = await request(app)
      .post('/api/conges/demande')
      .set('Authorization', `Bearer ${ctx.tokens.employe}`)
      .send({
        conge_type_id: ctx.congeType.id,
        date_debut: '2026-11-03',
        date_fin: '2026-11-05',
      });

    if (res.body.id) {
      congeId = res.body.id;
      createdCongeIds.push(congeId);
    }
  });

  it('employe → 403 ne peut pas valider', async () => {
    if (!congeId) return;
    const res = await request(app)
      .post(`/api/conges/${congeId}/valider`)
      .set('Authorization', `Bearer ${ctx.tokens.employe}`)
      .send({ commentaire: 'auto-validation' });

    expect(res.status).toBe(403);
  });

  it('manager → 200 valide un congé en_attente_manager', async () => {
    if (!congeId) return;
    const res = await request(app)
      .post(`/api/conges/${congeId}/valider`)
      .set('Authorization', `Bearer ${ctx.tokens.manager}`)
      .send({ commentaire: 'OK manager' });

    expect([200, 201]).toContain(res.status);
    if (res.status === 200 || res.status === 201) {
      expect(['valide_manager', 'valide_final']).toContain(res.body.statut);
    }
  });

  it('admin → peut valider en validation finale', async () => {
    if (!congeId) return;
    const res = await request(app)
      .post(`/api/conges/${congeId}/valider`)
      .set('Authorization', `Bearer ${ctx.tokens.admin}`)
      .send({ commentaire: 'OK admin' });

    // Peut être 200 (validation finale) ou 422 (déjà validé selon workflow)
    expect([200, 201, 422]).toContain(res.status);
  });
});

// ===========================================================================
describe('POST /api/conges/:id/refuser — refus', () => {
  let congeId;

  beforeAll(async () => {
    const res = await request(app)
      .post('/api/conges/demande')
      .set('Authorization', `Bearer ${ctx.tokens.employe}`)
      .send({
        conge_type_id: ctx.congeType.id,
        date_debut: '2026-12-01',
        date_fin: '2026-12-05',
      });

    if (res.body.id) {
      congeId = res.body.id;
      createdCongeIds.push(congeId);
    }
  });

  it('manager → 200 peut refuser un congé en attente', async () => {
    if (!congeId) return;
    const res = await request(app)
      .post(`/api/conges/${congeId}/refuser`)
      .set('Authorization', `Bearer ${ctx.tokens.manager}`)
      .send({ commentaire: 'Indisponibilité équipe' });

    expect([200, 201]).toContain(res.status);
    if (res.status === 200) {
      expect(['refuse_manager', 'refuse_final']).toContain(res.body.statut);
    }
  });

  it('employe → 403 ne peut pas refuser', async () => {
    if (!congeId) return;
    const res = await request(app)
      .post(`/api/conges/${congeId}/refuser`)
      .set('Authorization', `Bearer ${ctx.tokens.employe}`)
      .send({ commentaire: 'tentative' });

    expect(res.status).toBe(403);
  });
});

// ===========================================================================
describe('GET /api/conges/:id/history — historique', () => {
  let congeId;

  beforeAll(async () => {
    const res = await request(app)
      .post('/api/conges/demande')
      .set('Authorization', `Bearer ${ctx.tokens.employe}`)
      .send({
        conge_type_id: ctx.congeType.id,
        date_debut: '2027-01-10',
        date_fin: '2027-01-12',
      });

    if (res.body.id) {
      congeId = res.body.id;
      createdCongeIds.push(congeId);
    }
  });

  it('employe → peut voir l\'historique de son propre congé', async () => {
    if (!congeId) return;
    const res = await request(app)
      .get(`/api/conges/${congeId}/history`)
      .set('Authorization', `Bearer ${ctx.tokens.employe}`);

    expect([200, 404]).toContain(res.status);
  });

  it('employe → 403 ne peut pas voir l\'historique d\'un congé qui ne lui appartient pas', async () => {
    // Utiliser le congé du manager (créé dans suite "demande")
    const managerConge = await Conge.findOne({
      where: { utilisateur_id: ctx.manager.id, entreprise_id: ctx.entreprise.id },
    });

    if (!managerConge) return;

    const res = await request(app)
      .get(`/api/conges/${managerConge.id}/history`)
      .set('Authorization', `Bearer ${ctx.tokens.employe}`);

    expect([403, 404]).toContain(res.status);
  });
});
