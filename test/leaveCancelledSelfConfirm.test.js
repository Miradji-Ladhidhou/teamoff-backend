'use strict';
/**
 * leaveCancelledSelfConfirm.test.js
 *
 * Vérifie que sendLeaveCancelledSelfConfirm est envoyé à l'employé
 * quand il annule lui-même son congé (en attente ou validé manager),
 * et qu'il n'est PAS envoyé quand c'est un admin qui annule.
 *
 * Cas testés :
 *   A) Employé annule congé en_attente_manager → email de confirmation envoyé
 *   B) Employé annule congé valide_manager → email de confirmation envoyé
 *   C) Admin annule le congé d'un employé → sendLeaveCancelledSelfConfirm NON envoyé
 */

const request      = require('supertest');
const app          = require('../src/index');
const emailService = require('../src/services/emailService');
const { seed }     = require('./helpers/seed');
const { Conge, CompteurConges, LeavePolicy } = require('../src/models');

let ctx;

beforeAll(async () => {
  ctx = await seed();

  // Politique : autorise l'annulation de congés validés, sans délai de préavis
  await LeavePolicy.create({
    entreprise_id: ctx.entreprise.id,
    allow_cancel_validated: true,
    allow_modify_validated: true,
    min_notice_days: 0,
    require_manager_approval: true,
    require_admin_approval: false,
  });
});

afterAll(async () => {
  await Conge.destroy({ where: { entreprise_id: ctx.entreprise.id } });
  await CompteurConges.destroy({ where: { entreprise_id: ctx.entreprise.id } });
  await LeavePolicy.destroy({ where: { entreprise_id: ctx.entreprise.id } });
  await ctx.cleanup();
});

// ─── CAS A : congé en attente → email envoyé à l'employé ─────────────────────

describe('CAS A — annulation congé en_attente_manager → sendLeaveCancelledSelfConfirm appelé', () => {
  let spy;
  let res;

  beforeAll(async () => {
    await CompteurConges.create({
      entreprise_id: ctx.entreprise.id,
      utilisateur_id: ctx.employe.id,
      conge_type_id: ctx.congeType.id,
      annee: 2027,
      jours_acquis: 20,
      jours_pris: 0,
      jours_reportes: 0,
      jours_reserves: 5,
      jours_annules: 0,
    });

    const conge = await Conge.create({
      entreprise_id: ctx.entreprise.id,
      utilisateur_id: ctx.employe.id,
      conge_type_id: ctx.congeType.id,
      date_debut: '2027-06-01',
      date_fin: '2027-06-05',
      statut: 'en_attente_manager',
      jours_calcules: 5,
    });

    spy = jest.spyOn(emailService, 'sendLeaveCancelledSelfConfirm').mockResolvedValue(undefined);

    res = await request(app)
      .delete(`/api/conges/${conge.id}`)
      .set('Authorization', `Bearer ${ctx.tokens.employe}`);
  });

  afterAll(() => spy.mockRestore());

  it('retourne 200', () => {
    expect(res.status).toBe(204);
  });

  it('sendLeaveCancelledSelfConfirm est appelé une fois', () => {
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('le destinataire est l\'employé qui a annulé', () => {
    const [employe] = spy.mock.calls[0];
    expect(employe.id).toBe(ctx.employe.id);
  });

  it('le statut transmis est celui d\'une demande en attente', () => {
    const [, , , statutLabel] = spy.mock.calls[0];
    expect(statutLabel).toBe('demande de congé en attente');
  });
});

// ─── CAS B : congé valide_manager → email envoyé avec bon statut ─────────────

describe('CAS B — annulation congé valide_manager → sendLeaveCancelledSelfConfirm appelé', () => {
  let spy;
  let res;

  beforeAll(async () => {
    await CompteurConges.create({
      entreprise_id: ctx.entreprise.id,
      utilisateur_id: ctx.employe.id,
      conge_type_id: ctx.congeType.id,
      annee: 2028,
      jours_acquis: 20,
      jours_pris: 0,
      jours_reportes: 0,
      jours_reserves: 3,
      jours_annules: 0,
    });

    const conge = await Conge.create({
      entreprise_id: ctx.entreprise.id,
      utilisateur_id: ctx.employe.id,
      conge_type_id: ctx.congeType.id,
      date_debut: '2028-08-01',
      date_fin: '2028-08-03',
      statut: 'valide_manager',
      jours_calcules: 3,
    });

    spy = jest.spyOn(emailService, 'sendLeaveCancelledSelfConfirm').mockResolvedValue(undefined);

    res = await request(app)
      .delete(`/api/conges/${conge.id}`)
      .set('Authorization', `Bearer ${ctx.tokens.employe}`)
      .send({ commentaire: 'Changement de plan' });
  });

  afterAll(() => spy.mockRestore());

  it('retourne 200', () => {
    expect(res.status).toBe(204);
  });

  it('sendLeaveCancelledSelfConfirm est appelé une fois', () => {
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('le statut transmis est celui d\'un congé validé manager', () => {
    const [, , , statutLabel] = spy.mock.calls[0];
    expect(statutLabel).toBe('congé validé par le manager');
  });
});

// ─── CAS C : admin annule → sendLeaveCancelledSelfConfirm NON appelé ─────────

describe('CAS C — admin annule → sendLeaveCancelledSelfConfirm NON appelé', () => {
  let spy;

  beforeAll(async () => {
    await CompteurConges.create({
      entreprise_id: ctx.entreprise.id,
      utilisateur_id: ctx.employe.id,
      conge_type_id: ctx.congeType.id,
      annee: 2029,
      jours_acquis: 20,
      jours_pris: 0,
      jours_reportes: 0,
      jours_reserves: 4,
      jours_annules: 0,
    });

    const conge = await Conge.create({
      entreprise_id: ctx.entreprise.id,
      utilisateur_id: ctx.employe.id,
      conge_type_id: ctx.congeType.id,
      date_debut: '2029-04-01',
      date_fin: '2029-04-04',
      statut: 'en_attente_manager',
      jours_calcules: 4,
    });

    spy = jest.spyOn(emailService, 'sendLeaveCancelledSelfConfirm').mockResolvedValue(undefined);

    await request(app)
      .delete(`/api/conges/${conge.id}`)
      .set('Authorization', `Bearer ${ctx.tokens.admin}`);
  });

  afterAll(() => spy.mockRestore());

  it('sendLeaveCancelledSelfConfirm n\'est pas appelé quand c\'est l\'admin qui annule', () => {
    expect(spy).not.toHaveBeenCalled();
  });
});
