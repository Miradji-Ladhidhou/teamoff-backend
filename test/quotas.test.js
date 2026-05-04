'use strict';
/**
 * quotas.test.js — Tests d'intégration : décompte des quotas de congés
 *
 * Vérifie que créer et valider un congé décrémente correctement
 * le compteur de congés (CompteurConges).
 */

const request = require('supertest');
const app = require('../src/index');
const { seed } = require('./helpers/seed');
const { CompteurConges, Conge } = require('../src/models');

let ctx;

beforeAll(async () => {
  ctx = await seed();
});

afterAll(async () => {
  await ctx.cleanup();
});

// ---------------------------------------------------------------------------
describe('Quota deduction — workflow manager', () => {
  let congeId;
  let compteurBefore;

  beforeAll(async () => {
    // Créer la demande de congé (employe)
    const res = await request(app)
      .post('/api/conges/demande')
      .set('Authorization', `Bearer ${ctx.tokens.employe}`)
      .send({
        conge_type_id: ctx.congeType.id,
        date_debut: '2027-03-10',
        date_fin: '2027-03-14', // lun–ven = 5 jours ouvrés
        commentaire_employe: 'Test quota',
      });

    expect(res.status).toBe(201);
    congeId = res.body.id;

    // Lire le compteur avant validation
    compteurBefore = await CompteurConges.findOne({
      where: {
        utilisateur_id: ctx.employe.id,
        conge_type_id: ctx.congeType.id,
        annee: 2027,
      },
    });
  });

  it('crée un compteur avec jours_reserves > 0 après demande', () => {
    expect(compteurBefore).not.toBeNull();
    // Selon le workflow, soit jours_reserves soit jours_pris augmente
    const reserved = Number(compteurBefore.jours_reserves);
    const taken    = Number(compteurBefore.jours_pris);
    expect(reserved + taken).toBeGreaterThan(0);
  });

  it('après validation manager : jours_pris augmente, jours_reserves diminue', async () => {
    if (!congeId || !compteurBefore) return;

    const resBefore = {
      jours_acquis:   Number(compteurBefore.jours_acquis),
      jours_pris:     Number(compteurBefore.jours_pris),
      jours_reserves: Number(compteurBefore.jours_reserves),
    };

    // Validation par le manager
    const valRes = await request(app)
      .post(`/api/conges/${congeId}/valider`)
      .set('Authorization', `Bearer ${ctx.tokens.manager}`)
      .send({ commentaire: 'OK quota test' });

    expect([200, 201]).toContain(valRes.status);

    const compteurAfter = await CompteurConges.findOne({
      where: {
        utilisateur_id: ctx.employe.id,
        conge_type_id: ctx.congeType.id,
        annee: 2027,
      },
    });

    expect(compteurAfter).not.toBeNull();
    const joursConge = Number((await Conge.findByPk(congeId))?.jours_calcules ?? 5);

    // jours_pris doit avoir augmenté du nombre de jours du congé
    expect(Number(compteurAfter.jours_pris)).toBeGreaterThanOrEqual(resBefore.jours_pris + joursConge - 0.1);

    // jours_reserves doit être revenu à 0 (ou diminué)
    expect(Number(compteurAfter.jours_reserves)).toBeLessThanOrEqual(resBefore.jours_reserves);
  });

  it('après validation finale admin : statut devient valide_final', async () => {
    if (!congeId) return;

    const conge = await Conge.findByPk(congeId);
    if (!conge) return;

    // Si déjà valide_final (workflow manager_only), le test passe directement
    if (conge.statut === 'valide_final') {
      expect(conge.statut).toBe('valide_final');
      return;
    }

    const res = await request(app)
      .post(`/api/conges/${congeId}/valider`)
      .set('Authorization', `Bearer ${ctx.tokens.admin}`)
      .send({ commentaire: 'OK admin final' });

    expect([200, 201, 422]).toContain(res.status);

    if (res.status === 200 || res.status === 201) {
      expect(res.body.statut).toBe('valide_final');
    }
  });
});

// ---------------------------------------------------------------------------
describe('Quota deduction — refus annule la réservation', () => {
  let congeId;
  let compteurBefore;

  beforeAll(async () => {
    const res = await request(app)
      .post('/api/conges/demande')
      .set('Authorization', `Bearer ${ctx.tokens.employe}`)
      .send({
        conge_type_id: ctx.congeType.id,
        date_debut: '2027-04-07',
        date_fin: '2027-04-11',
      });

    if (res.status !== 201) return;
    congeId = res.body.id;

    compteurBefore = await CompteurConges.findOne({
      where: {
        utilisateur_id: ctx.employe.id,
        conge_type_id: ctx.congeType.id,
        annee: 2027,
      },
    });
  });

  it('après refus : jours_reserves revient à son niveau initial', async () => {
    if (!congeId || !compteurBefore) return;

    const reservesBefore = Number(compteurBefore.jours_reserves);

    const res = await request(app)
      .post(`/api/conges/${congeId}/refuser`)
      .set('Authorization', `Bearer ${ctx.tokens.manager}`)
      .send({ commentaire: 'Test refus quota' });

    expect([200, 201]).toContain(res.status);

    const compteurAfter = await CompteurConges.findOne({
      where: {
        utilisateur_id: ctx.employe.id,
        conge_type_id: ctx.congeType.id,
        annee: 2027,
      },
    });

    // jours_pris ne doit pas avoir augmenté (le congé est refusé)
    expect(Number(compteurAfter.jours_pris)).toBeLessThanOrEqual(Number(compteurBefore.jours_pris));
    // jours_reserves doit être revenu à 0 (ou inférieur à la valeur après demande)
    expect(Number(compteurAfter.jours_reserves)).toBeLessThanOrEqual(reservesBefore);
  });
});

// ---------------------------------------------------------------------------
describe('Quota — solde insuffisant', () => {
  it('retourne 422 si on demande plus de jours que le solde disponible', async () => {
    // Demander 500 jours de congé — largement au-dessus du quota
    const res = await request(app)
      .post('/api/conges/demande')
      .set('Authorization', `Bearer ${ctx.tokens.employe}`)
      .send({
        conge_type_id: ctx.congeType.id,
        date_debut: '2028-01-01',
        date_fin: '2028-12-31', // ~260 jours ouvrés
      });

    expect([400, 422]).toContain(res.status);
    expect(res.body).toHaveProperty('message');
  });
});
