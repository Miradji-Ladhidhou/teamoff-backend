'use strict';
/**
 * leaveRejectedManagerInfo.test.js
 *
 * Vérifie que sendLeaveRejectedManagerInfo est envoyé aux managers
 * quand un admin refuse un congé qui était déjà à l'état valide_manager.
 *
 * Cas testés :
 *   A) Admin refuse un congé valide_manager → managers notifiés
 *   B) Manager refuse un congé en_attente_manager → sendLeaveRejectedManagerInfo NON appelé
 *   C) Admin refuse un congé en_attente_manager (jamais validé par manager) → NON appelé
 */

const request      = require('supertest');
const bcrypt       = require('bcrypt');
const app          = require('../src/index');
const emailService = require('../src/services/emailService');
const { seed }     = require('./helpers/seed');
const { Conge, CompteurConges } = require('../src/models');

const HASH = bcrypt.hashSync('Test1234!', 10);

let ctx;

beforeAll(async () => {
  ctx = await seed();
});

afterAll(async () => {
  await Conge.destroy({ where: { entreprise_id: ctx.entreprise.id } });
  await CompteurConges.destroy({ where: { entreprise_id: ctx.entreprise.id } });
  await ctx.cleanup();
});

async function mkCompteur(annee = 2035) {
  return CompteurConges.create({
    entreprise_id: ctx.entreprise.id,
    utilisateur_id: ctx.employe.id,
    conge_type_id: ctx.congeType.id,
    annee,
    jours_acquis: 10,
    jours_pris: 0,
    jours_reportes: 0,
    jours_reserves: 3,
    jours_annules: 0,
  });
}

// ─── CAS A : admin refuse valide_manager → managers notifiés ─────────────────

describe('CAS A — admin refuse congé valide_manager → sendLeaveRejectedManagerInfo appelé', () => {
  let spy;
  let res;

  beforeAll(async () => {
    await mkCompteur(2035);

    const conge = await Conge.create({
      entreprise_id: ctx.entreprise.id,
      utilisateur_id: ctx.employe.id,
      conge_type_id: ctx.congeType.id,
      date_debut: '2035-10-01',
      date_fin: '2035-10-03',
      statut: 'valide_manager',
      jours_calcules: 3,
      jours_pris: 0,
    });

    spy = jest.spyOn(emailService, 'sendLeaveRejectedManagerInfo').mockResolvedValue(undefined);

    res = await request(app)
      .post(`/api/conges/${conge.id}/reject`)
      .set('Authorization', `Bearer ${ctx.tokens.admin}`)
      .send({ commentaire: 'Période trop chargée' });
  });

  afterAll(() => spy.mockRestore());

  it('retourne 200', () => {
    expect(res.status).toBe(200);
  });

  it('sendLeaveRejectedManagerInfo est appelé au moins une fois', () => {
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('le destinataire est le manager de l\'entreprise', () => {
    const [manager] = spy.mock.calls[0];
    expect(manager.email).toBe(ctx.manager.email);
  });

  it('employe_nom et admin_nom sont transmis', () => {
    const [, data] = spy.mock.calls[0];
    expect(data.employe_nom).toBeTruthy();
    expect(data.admin_nom).toBeTruthy();
  });

  it('le commentaire est transmis', () => {
    const [, data] = spy.mock.calls[0];
    expect(data.commentaire).toBe('Période trop chargée');
  });
});

// ─── CAS B : manager refuse en_attente_manager → NON appelé ─────────────────

describe('CAS B — manager refuse en_attente_manager → sendLeaveRejectedManagerInfo NON appelé', () => {
  let spy;

  beforeAll(async () => {
    await mkCompteur(2036);

    const conge = await Conge.create({
      entreprise_id: ctx.entreprise.id,
      utilisateur_id: ctx.employe.id,
      conge_type_id: ctx.congeType.id,
      date_debut: '2036-10-01',
      date_fin: '2036-10-03',
      statut: 'en_attente_manager',
      jours_calcules: 3,
      jours_pris: 0,
    });

    spy = jest.spyOn(emailService, 'sendLeaveRejectedManagerInfo').mockResolvedValue(undefined);

    await request(app)
      .post(`/api/conges/${conge.id}/reject`)
      .set('Authorization', `Bearer ${ctx.tokens.manager}`)
      .send({ commentaire: 'Refus manager' });
  });

  afterAll(() => spy.mockRestore());

  it('sendLeaveRejectedManagerInfo n\'est pas appelé', () => {
    expect(spy).not.toHaveBeenCalled();
  });
});

// ─── CAS C : admin refuse en_attente_manager (jamais validé) → NON appelé ────

describe('CAS C — admin refuse en_attente_manager → sendLeaveRejectedManagerInfo NON appelé', () => {
  let spy;

  beforeAll(async () => {
    await mkCompteur(2037);

    const conge = await Conge.create({
      entreprise_id: ctx.entreprise.id,
      utilisateur_id: ctx.employe.id,
      conge_type_id: ctx.congeType.id,
      date_debut: '2037-10-01',
      date_fin: '2037-10-03',
      statut: 'en_attente_manager',
      jours_calcules: 3,
      jours_pris: 0,
    });

    spy = jest.spyOn(emailService, 'sendLeaveRejectedManagerInfo').mockResolvedValue(undefined);

    await request(app)
      .post(`/api/conges/${conge.id}/reject`)
      .set('Authorization', `Bearer ${ctx.tokens.admin}`)
      .send({ commentaire: 'Refus direct admin' });
  });

  afterAll(() => spy.mockRestore());

  it('sendLeaveRejectedManagerInfo n\'est pas appelé', () => {
    expect(spy).not.toHaveBeenCalled();
  });
});
