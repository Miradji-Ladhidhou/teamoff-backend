'use strict';
/**
 * leaveCancelledByAdmin.test.js
 *
 * Vérifie que sendLeaveCancelledByAdmin est envoyé aux managers quand
 * un admin annule un congé validé d'un employé, et qu'il n'est PAS
 * envoyé quand c'est l'employé lui-même qui annule.
 *
 * Cas testés :
 *   A) Admin annule congé valide_manager → sendLeaveCancelledByAdmin appelé pour chaque manager
 *   B) Admin annule congé valide_final → sendLeaveCancelledByAdmin appelé pour chaque manager
 *   C) Employé annule son propre congé → sendLeaveCancelledByAdmin NON appelé
 */

const request      = require('supertest');
const app          = require('../src/index');
const emailService = require('../src/services/emailService');
const { seed }     = require('./helpers/seed');
const { Conge, CompteurConges, LeavePolicy } = require('../src/models');

let ctx;

beforeAll(async () => {
  ctx = await seed();

  // Politique permettant l'annulation de congés validés (pour CAS C)
  await LeavePolicy.create({
    entreprise_id: ctx.entreprise.id,
    allow_cancel_validated: true,
    allow_modify_validated: false,
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

// ─── CAS A : admin annule valide_manager → managers notifiés ─────────────────

describe('CAS A — admin annule valide_manager → sendLeaveCancelledByAdmin appelé', () => {
  let spy;
  let res;

  beforeAll(async () => {
    await CompteurConges.create({
      entreprise_id: ctx.entreprise.id,
      utilisateur_id: ctx.employe.id,
      conge_type_id: ctx.congeType.id,
      annee: 2030,
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
      date_debut: '2030-07-01',
      date_fin: '2030-07-05',
      statut: 'valide_manager',
      jours_calcules: 5,
    });

    spy = jest.spyOn(emailService, 'sendLeaveCancelledByAdmin').mockResolvedValue(undefined);

    res = await request(app)
      .delete(`/api/conges/${conge.id}`)
      .set('Authorization', `Bearer ${ctx.tokens.admin}`)
      .send({ commentaire: 'Reorganisation planning' });
  });

  afterAll(() => spy.mockRestore());

  it('retourne 204', () => {
    expect(res.status).toBe(204);
  });

  it('sendLeaveCancelledByAdmin est appelé une fois par manager actif', () => {
    // Le seed crée 1 manager actif dans l'entreprise
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('le destinataire est le manager de l\'entreprise', () => {
    const [manager] = spy.mock.calls[0];
    expect(manager.id).toBe(ctx.manager.id);
  });

  it('employe_nom et admin_nom sont transmis correctement', () => {
    const [, employeNom, adminNom] = spy.mock.calls[0];
    expect(employeNom).toContain(ctx.employe.prenom);
    expect(adminNom).toContain(ctx.admin.prenom);
  });
});

// ─── CAS B : admin annule valide_final → managers notifiés ───────────────────

describe('CAS B — admin annule valide_final → sendLeaveCancelledByAdmin appelé', () => {
  let spy;

  beforeAll(async () => {
    await CompteurConges.create({
      entreprise_id: ctx.entreprise.id,
      utilisateur_id: ctx.employe.id,
      conge_type_id: ctx.congeType.id,
      annee: 2031,
      jours_acquis: 20,
      jours_pris: 3,
      jours_reportes: 0,
      jours_reserves: 0,
      jours_annules: 0,
    });

    const conge = await Conge.create({
      entreprise_id: ctx.entreprise.id,
      utilisateur_id: ctx.employe.id,
      conge_type_id: ctx.congeType.id,
      date_debut: '2031-03-10',
      date_fin: '2031-03-12',
      statut: 'valide_final',
      jours_calcules: 3,
    });

    spy = jest.spyOn(emailService, 'sendLeaveCancelledByAdmin').mockResolvedValue(undefined);

    await request(app)
      .delete(`/api/conges/${conge.id}`)
      .set('Authorization', `Bearer ${ctx.tokens.admin}`)
      .send({ commentaire: 'Erreur de saisie' });
  });

  afterAll(() => spy.mockRestore());

  it('sendLeaveCancelledByAdmin est appelé une fois', () => {
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

// ─── CAS C : employé annule → sendLeaveCancelledByAdmin NON appelé ────────────

describe('CAS C — employé annule son propre congé → sendLeaveCancelledByAdmin NON appelé', () => {
  let spy;

  beforeAll(async () => {
    await CompteurConges.create({
      entreprise_id: ctx.entreprise.id,
      utilisateur_id: ctx.employe.id,
      conge_type_id: ctx.congeType.id,
      annee: 2032,
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
      date_debut: '2032-09-01',
      date_fin: '2032-09-04',
      statut: 'en_attente_manager',
      jours_calcules: 4,
    });

    spy = jest.spyOn(emailService, 'sendLeaveCancelledByAdmin').mockResolvedValue(undefined);

    await request(app)
      .delete(`/api/conges/${conge.id}`)
      .set('Authorization', `Bearer ${ctx.tokens.employe}`);
  });

  afterAll(() => spy.mockRestore());

  it('sendLeaveCancelledByAdmin n\'est pas appelé quand l\'employé annule lui-même', () => {
    expect(spy).not.toHaveBeenCalled();
  });
});
