'use strict';
/**
 * leaveUpdatedSelfConfirm.test.js
 *
 * Vérifie que sendLeaveUpdatedSelfConfirm est envoyé à l'employé quand
 * il modifie lui-même sa demande en attente, et qu'il n'est PAS envoyé
 * quand c'est un admin qui modifie la demande.
 *
 * Cas testés :
 *   A) Employé modifie son propre congé en_attente_manager → email de confirmation envoyé
 *   B) Admin modifie le congé en attente d'un employé → sendLeaveUpdatedSelfConfirm NON envoyé
 */

const request      = require('supertest');
const app          = require('../src/index');
const emailService = require('../src/services/emailService');
const { seed }     = require('./helpers/seed');
const { Conge, CompteurConges } = require('../src/models');

let ctx;

beforeAll(async () => {
  ctx = await seed();
});

afterAll(async () => {
  await Conge.destroy({ where: { entreprise_id: ctx.entreprise.id } });
  await CompteurConges.destroy({ where: { entreprise_id: ctx.entreprise.id } });
  await ctx.cleanup();
});

// ─── CAS A : employé modifie son congé en attente → email envoyé ─────────────

describe('CAS A — employé modifie congé en_attente_manager → sendLeaveUpdatedSelfConfirm appelé', () => {
  let spy;
  let res;

  beforeAll(async () => {
    await CompteurConges.create({
      entreprise_id: ctx.entreprise.id,
      utilisateur_id: ctx.employe.id,
      conge_type_id: ctx.congeType.id,
      annee: 2035,
      jours_acquis: 10,
      jours_pris: 0,
      jours_reportes: 0,
      jours_reserves: 3,
      jours_annules: 0,
    });

    // Lundi → mercredi 2035 (3 jours ouvrés, pas de férié attendu)
    const conge = await Conge.create({
      entreprise_id: ctx.entreprise.id,
      utilisateur_id: ctx.employe.id,
      conge_type_id: ctx.congeType.id,
      date_debut: '2035-09-02',
      date_fin: '2035-09-04',
      statut: 'en_attente_manager',
      jours_calcules: 3,
    });

    spy = jest.spyOn(emailService, 'sendLeaveUpdatedSelfConfirm').mockResolvedValue(undefined);

    res = await request(app)
      .put(`/api/conges/${conge.id}`)
      .set('Authorization', `Bearer ${ctx.tokens.employe}`)
      .send({ commentaire_employe: 'Mise à jour du motif' });
  });

  afterAll(() => spy.mockRestore());

  it('retourne 200', () => {
    expect(res.status).toBe(200);
  });

  it('sendLeaveUpdatedSelfConfirm est appelé une fois', () => {
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('le destinataire est l\'employé qui a modifié', () => {
    const [employe] = spy.mock.calls[0];
    expect(employe.id).toBe(ctx.employe.id);
  });

  it('les périodes ancienne et nouvelle sont transmises', () => {
    const [, , anciennePeriode, nouvellePeriode] = spy.mock.calls[0];
    expect(typeof anciennePeriode).toBe('string');
    expect(typeof nouvellePeriode).toBe('string');
    expect(anciennePeriode).not.toBe('');
    expect(nouvellePeriode).not.toBe('');
  });
});

// ─── CAS B : admin modifie le congé → sendLeaveUpdatedSelfConfirm NON envoyé ──

describe('CAS B — admin modifie congé en_attente_manager → sendLeaveUpdatedSelfConfirm NON appelé', () => {
  let spy;

  beforeAll(async () => {
    await CompteurConges.create({
      entreprise_id: ctx.entreprise.id,
      utilisateur_id: ctx.employe.id,
      conge_type_id: ctx.congeType.id,
      annee: 2036,
      jours_acquis: 10,
      jours_pris: 0,
      jours_reportes: 0,
      jours_reserves: 3,
      jours_annules: 0,
    });

    const conge = await Conge.create({
      entreprise_id: ctx.entreprise.id,
      utilisateur_id: ctx.employe.id,
      conge_type_id: ctx.congeType.id,
      date_debut: '2036-09-01',
      date_fin: '2036-09-03',
      statut: 'en_attente_manager',
      jours_calcules: 3,
    });

    spy = jest.spyOn(emailService, 'sendLeaveUpdatedSelfConfirm').mockResolvedValue(undefined);

    await request(app)
      .put(`/api/conges/${conge.id}`)
      .set('Authorization', `Bearer ${ctx.tokens.admin}`)
      .send({ commentaire_employe: 'Note admin' });
  });

  afterAll(() => spy.mockRestore());

  it('sendLeaveUpdatedSelfConfirm n\'est pas appelé quand c\'est l\'admin qui modifie', () => {
    expect(spy).not.toHaveBeenCalled();
  });
});
