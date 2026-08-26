'use strict';
/**
 * absenceNotificationServiceFilter.test.js — Fix #67
 *
 * PROBLÈME :
 *   notifyAbsenceCreated (absenceService.js:10) envoyait un email à TOUS les
 *   managers de l'entreprise, sans filtre par service.
 *   Un manager du service IT recevait les notifications d'un employé RH et inversement.
 *
 * CORRECTION :
 *   1re requête : managers du même service que l'employé (+ statut actif).
 *   Fallback   : tous les managers actifs de l'entreprise si aucun dans ce service.
 *
 * TESTS :
 *   A — employé service RH → seul le manager RH est notifié (manager IT non notifié)
 *   B — employé sans service → tous les managers reçoivent la notification (fallback)
 *   C — employé dont le service n'a pas de manager → fallback : tous managers notifiés
 */

jest.mock('../src/services/emailService', () => ({
  sendEmail:             jest.fn().mockResolvedValue(undefined),
  sendLeavePendingReminder: jest.fn(),
  sendInvitationReminder:   jest.fn(),
  sendLeaveReminder:        jest.fn(),
  sendMonthlyReport:        jest.fn(),
  sendWeeklyManagerSummary: jest.fn(),
  getSmtpConfig:            jest.fn().mockResolvedValue({}),
}));

const bcrypt     = require('bcrypt');
const { Entreprise, Utilisateur, Absence } = require('../src/models');
const emailService = require('../src/services/emailService');
const { notifyAbsenceCreated } = require('../src/services/absenceService');

const TS = Date.now();

let ent, empRH, empSansService, mgrRH, mgrIT;

beforeAll(async () => {
  const hash = await bcrypt.hash('Test1234!', 10);

  ent = await Entreprise.create({
    nom: `AbsNotifFilter_${TS}`,
    politique_conges: {},
    parametres: {},
    statut: 'active',
  });

  // Employé service RH
  empRH = await Utilisateur.create({
    entreprise_id: ent.id,
    prenom: 'Alice',
    nom: 'RH67',
    email: `alice.rh.67.${TS}@test.internal`,
    role: 'employe',
    password_hash: hash,
    statut: 'actif',
    service: 'RH',
  });

  // Employé sans service
  empSansService = await Utilisateur.create({
    entreprise_id: ent.id,
    prenom: 'Bob',
    nom: 'NoSvc67',
    email: `bob.nosvc.67.${TS}@test.internal`,
    role: 'employe',
    password_hash: hash,
    statut: 'actif',
    service: null,
  });

  // Manager service RH
  mgrRH = await Utilisateur.create({
    entreprise_id: ent.id,
    prenom: 'ManagerRH',
    nom: 'RH67',
    email: `mgr.rh.67.${TS}@test.internal`,
    role: 'manager',
    password_hash: hash,
    statut: 'actif',
    service: 'RH',
  });

  // Manager service IT (ne doit pas recevoir les absences RH)
  mgrIT = await Utilisateur.create({
    entreprise_id: ent.id,
    prenom: 'ManagerIT',
    nom: 'IT67',
    email: `mgr.it.67.${TS}@test.internal`,
    role: 'manager',
    password_hash: hash,
    statut: 'actif',
    service: 'IT',
  });
});

afterAll(async () => {
  await Absence.destroy({ where: { entreprise_id: ent.id } });
  await Utilisateur.destroy({ where: { entreprise_id: ent.id } });
  await Entreprise.destroy({ where: { id: ent.id } });
});

beforeEach(() => {
  emailService.sendEmail.mockClear();
});

// Crée une fausse absence (sans toucher la DB pour simplifier le test unitaire)
function fakeAbsence(utilisateur_id) {
  return {
    utilisateur_id,
    type_absence: 'absence_exceptionnelle',
    date_debut: '2025-06-01',
    date_fin:   '2025-06-01',
    commentaire: 'Test',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// A — Employé service RH → seul le manager RH est notifié
// ─────────────────────────────────────────────────────────────────────────────
describe('Fix #67 A — employé RH : seul le manager RH reçoit la notification', () => {
  it('manager IT non notifié quand service=RH', async () => {
    await notifyAbsenceCreated(fakeAbsence(empRH.id), ent.id);

    const sentTo = emailService.sendEmail.mock.calls.map(([to]) => to);

    // Le manager RH doit être notifié
    expect(sentTo).toContain(mgrRH.email);

    // Le manager IT ne doit pas être notifié (service différent)
    expect(sentTo).not.toContain(mgrIT.email);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B — Employé sans service → fallback : tous les managers reçoivent la notif
// ─────────────────────────────────────────────────────────────────────────────
describe('Fix #67 B — employé sans service : tous les managers en fallback', () => {
  it('manager RH et manager IT tous deux notifiés', async () => {
    await notifyAbsenceCreated(fakeAbsence(empSansService.id), ent.id);

    const sentTo = emailService.sendEmail.mock.calls.map(([to]) => to);

    expect(sentTo).toContain(mgrRH.email);
    expect(sentTo).toContain(mgrIT.email);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C — Employé service 'Finance' (aucun manager dans ce service)
//     → fallback : tous les managers de l'entreprise sont notifiés
// ─────────────────────────────────────────────────────────────────────────────
describe('Fix #67 C — aucun manager dans le service employé → fallback tous managers', () => {
  let empFinance;

  beforeAll(async () => {
    const hash = await bcrypt.hash('Test1234!', 10);
    empFinance = await Utilisateur.create({
      entreprise_id: ent.id,
      prenom: 'Carol',
      nom: 'Finance67',
      email: `carol.finance.67.${TS}@test.internal`,
      role: 'employe',
      password_hash: hash,
      statut: 'actif',
      service: 'Finance',
    });
  });

  afterAll(async () => {
    if (empFinance) await empFinance.destroy();
  });

  it('manager RH et manager IT notifiés (fallback, service Finance sans manager)', async () => {
    await notifyAbsenceCreated(fakeAbsence(empFinance.id), ent.id);

    const sentTo = emailService.sendEmail.mock.calls.map(([to]) => to);

    expect(sentTo).toContain(mgrRH.email);
    expect(sentTo).toContain(mgrIT.email);
  });
});
