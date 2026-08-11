'use strict';
/**
 * actionRejectedManagerEmail.test.js
 *
 * Vérifie que notificationService.sendEmail est appelé pour les managers
 * quand un admin refuse une demande cancel/modify (flux Action Request).
 *
 * Cas testés :
 *   A) Admin refuse une demande d'annulation → sendEmail appelé pour le manager
 *   B) Admin refuse une demande de modification → sendEmail appelé pour le manager
 *   C) L'employé reçoit aussi son email de refus (toujours)
 *   D) Un admin d'une autre entreprise n'a pas accès → 404, pas d'email
 */

const request             = require('supertest');
const bcrypt              = require('bcrypt');
const app                 = require('../src/index');
const notificationService = require('../src/services/notificationService');
const {
  Entreprise, Utilisateur, CongeType, CompteurConges, Conge, CongeActionRequest, LeavePolicy,
} = require('../src/models');
const { generateToken } = require('./helpers/auth');
const dayjs = require('dayjs');

const TS   = Date.now();
const YEAR = dayjs().year();
const HASH = bcrypt.hashSync('Test1234!', 10);

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

let ent, admin, manager, employe, congeType;
let tokenAdmin, tokenEmploye;
let entB, adminB, tokenAdminB;

const createdRequestIds = [];
const createdCongeIds   = [];

async function mkCompteur(e, user, ct) {
  const [c] = await CompteurConges.findOrCreate({
    where: { entreprise_id: e.id, utilisateur_id: user.id, conge_type_id: ct.id, annee: YEAR },
    defaults: { jours_acquis: 30, jours_reserves: 0, jours_pris: 0 },
  });
  await c.update({ jours_acquis: 30, jours_reserves: 0, jours_pris: 0 });
  return c;
}

async function mkConge(e, user, ct, statut, dates = {}) {
  const debut = dates.debut || `${YEAR + 1}-06-01`;
  const fin   = dates.fin   || `${YEAR + 1}-06-07`;
  const c = await Conge.create({
    entreprise_id: e.id,
    utilisateur_id: user.id,
    conge_type_id: ct.id,
    date_debut: debut,
    date_fin: fin,
    debut_demi_journee: 'matin',
    fin_demi_journee: 'apres_midi',
    statut,
    jours_calcules: 5,
    jours_pris: statut === 'valide_final' ? 5 : 0,
  });
  createdCongeIds.push(c.id);
  return c;
}

// ─────────────────────────────────────────────────────────────────────────────
beforeAll(async () => {
  ent = await Entreprise.create({
    nom: `ARM_${TS}`,
    politique_conges: {},
    parametres: {},
    statut: 'active',
  });

  admin = await Utilisateur.create({
    entreprise_id: ent.id, prenom: 'Admin', nom: `ARM${TS}`,
    email: `adm.arm.${TS}@test.internal`,
    role: 'admin_entreprise', password_hash: HASH, statut: 'actif',
  });
  manager = await Utilisateur.create({
    entreprise_id: ent.id, prenom: 'Mgr', nom: `ARM${TS}`,
    email: `mgr.arm.${TS}@test.internal`,
    role: 'manager', password_hash: HASH, statut: 'actif',
  });
  employe = await Utilisateur.create({
    entreprise_id: ent.id, prenom: 'Emp', nom: `ARM${TS}`,
    email: `emp.arm.${TS}@test.internal`,
    role: 'employe', password_hash: HASH, statut: 'actif',
  });

  congeType = await CongeType.create({
    entreprise_id: ent.id, libelle: `CP_ARM_${TS}`,
    code: `ARM${String(TS).slice(-6)}`,
    deductible: true, demi_journee_autorisee: true, quota_annuel: 25,
  });

  entB = await Entreprise.create({ nom: `ARM_B_${TS}`, politique_conges: {}, parametres: {}, statut: 'active' });
  adminB = await Utilisateur.create({
    entreprise_id: entB.id, prenom: 'AdmB', nom: `ARM${TS}`,
    email: `adm.b.arm.${TS}@test.internal`,
    role: 'admin_entreprise', password_hash: HASH, statut: 'actif',
  });

  await LeavePolicy.create({
    entreprise_id: ent.id,
    allow_cancel_validated: true,
    allow_modify_validated: true,
    min_notice_days: 0,
    require_manager_approval: true,
    require_admin_approval: false,
  });

  tokenAdmin   = generateToken(admin);
  tokenEmploye = generateToken(employe);
  tokenAdminB  = generateToken(adminB);

  await mkCompteur(ent, employe, congeType);
});

afterAll(async () => {
  if (createdRequestIds.length) {
    await CongeActionRequest.destroy({ where: { id: createdRequestIds } });
  }
  if (createdCongeIds.length) {
    await CongeActionRequest.destroy({ where: { conge_id: createdCongeIds } });
    await Conge.destroy({ where: { id: createdCongeIds } });
  }
  await CompteurConges.destroy({ where: { entreprise_id: ent.id } });
  await CongeType.destroy({ where: { entreprise_id: ent.id } });
  await LeavePolicy.destroy({ where: { entreprise_id: [ent.id, entB.id] } });
  await Utilisateur.destroy({ where: { entreprise_id: [ent.id, entB.id] } });
  await Entreprise.destroy({ where: { id: [ent.id, entB.id] } });
});

// ─────────────────────────────────────────────────────────────────────────────
// CAS A — refus d'une demande d'annulation → manager reçoit un email
// ─────────────────────────────────────────────────────────────────────────────

describe('CAS A — admin refuse demande annulation → email envoyé au manager', () => {
  let spy;
  let res;

  beforeAll(async () => {
    const conge = await mkConge(ent, employe, congeType, 'valide_final', {
      debut: `${YEAR + 1}-07-01`, fin: `${YEAR + 1}-07-07`,
    });

    // Soumettre une demande d'annulation
    const submitRes = await request(app)
      .post(`/api/conges/${conge.id}/action-request`)
      .set('Authorization', `Bearer ${tokenEmploye}`)
      .send({ type: 'cancel', commentaire: 'Je dois annuler ce congé' });
    const actionReq = submitRes.body;
    createdRequestIds.push(actionReq.id);

    spy = jest.spyOn(notificationService, 'sendEmail').mockResolvedValue(undefined);

    res = await request(app)
      .post(`/api/conges/action-requests/${actionReq.id}/reject`)
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ commentaire: 'Annulation non justifiée' });
  });

  afterAll(() => spy.mockRestore());

  it('retourne 200', () => {
    expect(res.status).toBe(200);
  });

  it('sendEmail est appelé au moins une fois pour le manager', () => {
    const managerCalls = spy.mock.calls.filter(([params]) => params.to === manager.email);
    expect(managerCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('le templateName du manager est leave-action-rejected', () => {
    const managerCall = spy.mock.calls.find(([params]) => params.to === manager.email);
    expect(managerCall[0].templateName).toBe('leave-action-rejected');
  });

  it('l\'email du manager contient employe_nom et message_principal', () => {
    const managerCall = spy.mock.calls.find(([params]) => params.to === manager.email);
    const data = managerCall[0].data;
    expect(data.employe_nom).toBeTruthy();
    expect(data.message_principal).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CAS B — refus d'une demande de modification → manager reçoit un email
// ─────────────────────────────────────────────────────────────────────────────

describe('CAS B — admin refuse demande modification → email envoyé au manager', () => {
  let spy;
  let res;

  beforeAll(async () => {
    const conge = await mkConge(ent, employe, congeType, 'valide_final', {
      debut: `${YEAR + 1}-08-01`, fin: `${YEAR + 1}-08-07`,
    });

    // Soumettre une demande de modification
    const submitRes = await request(app)
      .post(`/api/conges/${conge.id}/action-request`)
      .set('Authorization', `Bearer ${tokenEmploye}`)
      .send({
        type: 'modify',
        commentaire: 'Je veux décaler',
        date_debut_demandee: `${YEAR + 1}-08-10`,
        date_fin_demandee: `${YEAR + 1}-08-14`,
        debut_demi_journee_demandee: 'matin',
        fin_demi_journee_demandee: 'apres_midi',
      });
    const actionReq = submitRes.body;
    createdRequestIds.push(actionReq.id);

    spy = jest.spyOn(notificationService, 'sendEmail').mockResolvedValue(undefined);

    res = await request(app)
      .post(`/api/conges/action-requests/${actionReq.id}/reject`)
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ commentaire: 'Modification impossible en haute saison' });
  });

  afterAll(() => spy.mockRestore());

  it('retourne 200', () => {
    expect(res.status).toBe(200);
  });

  it('sendEmail est appelé pour le manager', () => {
    const managerCalls = spy.mock.calls.filter(([params]) => params.to === manager.email);
    expect(managerCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('le sujet du manager mentionne le refus', () => {
    const managerCall = spy.mock.calls.find(([params]) => params.to === manager.email);
    expect(managerCall[0].subject).toMatch(/refus/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CAS C — l'employé reçoit toujours son email de refus
// ─────────────────────────────────────────────────────────────────────────────

describe('CAS C — l\'employé reçoit son email leave-action-rejected', () => {
  let spy;

  beforeAll(async () => {
    const conge = await mkConge(ent, employe, congeType, 'valide_final', {
      debut: `${YEAR + 1}-09-01`, fin: `${YEAR + 1}-09-05`,
    });

    const submitRes = await request(app)
      .post(`/api/conges/${conge.id}/action-request`)
      .set('Authorization', `Bearer ${tokenEmploye}`)
      .send({ type: 'cancel', commentaire: 'Annulation demandée' });
    const actionReq = submitRes.body;
    createdRequestIds.push(actionReq.id);

    spy = jest.spyOn(notificationService, 'sendEmail').mockResolvedValue(undefined);

    await request(app)
      .post(`/api/conges/action-requests/${actionReq.id}/reject`)
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ commentaire: 'Non justifié' });
  });

  afterAll(() => spy.mockRestore());

  it('sendEmail est appelé pour l\'employé avec leave-action-rejected', () => {
    const employeCall = spy.mock.calls.find(
      ([params]) => params.to === employe.email && params.templateName === 'leave-action-rejected'
    );
    expect(employeCall).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CAS D — admin d'une autre entreprise → 404, aucun email
// ─────────────────────────────────────────────────────────────────────────────

describe('CAS D — admin autre entreprise → 404, pas d\'email manager', () => {
  let spy;
  let res;

  beforeAll(async () => {
    const conge = await mkConge(ent, employe, congeType, 'valide_final', {
      debut: `${YEAR + 1}-10-01`, fin: `${YEAR + 1}-10-07`,
    });

    const submitRes = await request(app)
      .post(`/api/conges/${conge.id}/action-request`)
      .set('Authorization', `Bearer ${tokenEmploye}`)
      .send({ type: 'cancel', commentaire: 'Annulation' });
    const actionReq = submitRes.body;
    createdRequestIds.push(actionReq.id);

    spy = jest.spyOn(notificationService, 'sendEmail').mockResolvedValue(undefined);

    res = await request(app)
      .post(`/api/conges/action-requests/${actionReq.id}/reject`)
      .set('Authorization', `Bearer ${tokenAdminB}`)
      .send({ commentaire: 'Refus cross-tenant' });
  });

  afterAll(() => spy.mockRestore());

  it('retourne 404', () => {
    expect(res.status).toBe(404);
  });

  it('aucun email envoyé', () => {
    expect(spy).not.toHaveBeenCalled();
  });
});
