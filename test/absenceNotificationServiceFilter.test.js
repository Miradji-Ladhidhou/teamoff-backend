'use strict';
/**
 * absenceNotificationServiceFilter.test.js — Fix #67
 *
 * PROBLÈME :
 *   notifyAbsenceCreated (absenceService.js:10) envoyait un email à TOUS les
 *   managers de l'entreprise, sans filtre par service.
 *   Un manager du service IT recevait les notifications d'un employé RH et inversement.
 *
 * Les managers actifs sont notifiés pour leur propre service ou si leur
 * service autorise explicitement les absences interservices.
 *
 * TESTS :
 *   A — employé service RH → seul le manager RH est notifié (manager IT non notifié)
 *   B/C — sans service ou sans manager local : aucun repli interservices implicite
 */

jest.mock('../src/services/emailService', () => ({
  sendEmail:             jest.fn().mockResolvedValue(undefined),
  sendLeavePendingReminder: jest.fn(),
  sendInvitationReminder:   jest.fn(),
  sendLeaveReminder:        jest.fn(),
  sendMonthlyReport:        jest.fn(),
  sendWeeklySummary:        jest.fn(),
  getSmtpConfig:            jest.fn().mockResolvedValue({}),
}));

const bcrypt     = require('bcrypt');
const { Entreprise, Utilisateur, Absence } = require('../src/models');
const emailService = require('../src/services/emailService');
const { notifyAbsenceCreated } = require('../src/services/absenceService');
const notificationService = require('../src/services/notificationService');

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

beforeEach(async () => {
  emailService.sendEmail.mockClear();
  await ent.update({ politique_conges: {} });
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
describe('Employé sans service : pas de repli implicite', () => {
  it('ne notifie pas les managers sans autorisation interservices', async () => {
    await notifyAbsenceCreated(fakeAbsence(empSansService.id), ent.id);

    const sentTo = emailService.sendEmail.mock.calls.map(([to]) => to);

    expect(sentTo).not.toContain(mgrRH.email);
    expect(sentTo).not.toContain(mgrIT.email);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C — Employé service 'Finance' (aucun manager dans ce service)
//     → fallback : tous les managers de l'entreprise sont notifiés
// ─────────────────────────────────────────────────────────────────────────────
describe('Aucun manager dans le service employé : pas de repli implicite', () => {
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

  it('ne notifie pas les managers des autres services sans autorisation', async () => {
    await notifyAbsenceCreated(fakeAbsence(empFinance.id), ent.id);

    const sentTo = emailService.sendEmail.mock.calls.map(([to]) => to);

    expect(sentTo).not.toContain(mgrRH.email);
    expect(sentTo).not.toContain(mgrIT.email);
  });
});

describe('Canaux d’absence indépendants', () => {
  afterEach(() => jest.restoreAllMocks());

  it.each(['maladie', 'absence_exceptionnelle'])('application seule pour %s : pas d’email, pas de validation imposée, pas de commentaire privé', async type => {
    await ent.update({ politique_conges: { service_policies: { IT: {
      manager_cross_service: { [type]: { view: false, email: false, in_app: true, participation: 'information' } },
    } } } });
    const create = jest.spyOn(notificationService, 'creerNotification').mockResolvedValue({});
    await notifyAbsenceCreated({ ...fakeAbsence(empRH.id), type_absence: type, commentaire: 'Motif privé' }, ent.id);
    expect(emailService.sendEmail.mock.calls.map(([to]) => to)).not.toContain(mgrIT.email);
    expect(emailService.sendEmail.mock.calls.map(([to]) => to)).toContain(mgrRH.email);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      utilisateur_id: mgrIT.id, delivery: expect.objectContaining({ mode: 'information', canView: false, in_app: true }),
    }));
    expect(create.mock.calls[0][0].message).not.toContain('Motif privé');
  });

  it('email seul pour maladie ne notifie pas les absences exceptionnelles', async () => {
    await ent.update({ politique_conges: { service_policies: { IT: {
      manager_cross_service: { maladie: { view: false, email: true, in_app: false, participation: 'information' } },
    } } } });
    const create = jest.spyOn(notificationService, 'creerNotification').mockResolvedValue({});
    await notifyAbsenceCreated({ ...fakeAbsence(empRH.id), type_absence: 'maladie', commentaire: 'Motif privé' }, ent.id);
    const crossEmail = emailService.sendEmail.mock.calls.find(([to]) => to === mgrIT.email);
    expect(crossEmail).toBeDefined();
    expect(crossEmail[3].notification_mode).toBe('information');
    expect(crossEmail[3].content).not.toContain('Motif privé');
    expect(create).not.toHaveBeenCalled();
    emailService.sendEmail.mockClear();
    await notifyAbsenceCreated(fakeAbsence(empRH.id), ent.id);
    expect(emailService.sendEmail.mock.calls.map(([to]) => to)).not.toContain(mgrIT.email);
  });
});

describe('Absences interservices activées sur le service du manager', () => {
  it.each(['maladie', 'absence_exceptionnelle'])('notifie le manager IT pour une absence RH de type %s', async (type) => {
    await ent.update({
      politique_conges: { service_policies: { IT: { manager_can_view_all_absences: true } } },
    });
    await notifyAbsenceCreated({ ...fakeAbsence(empRH.id), type_absence: type }, ent.id);
    const sentTo = emailService.sendEmail.mock.calls.map(([to]) => to);
    expect(sentTo).toContain(empRH.email);
    expect(sentTo.filter(email => email === mgrRH.email)).toHaveLength(1);
    expect(sentTo.filter(email => email === mgrIT.email)).toHaveLength(1);
    expect(emailService.sendEmail).toHaveBeenCalledWith(
      mgrIT.email, 'Nouvelle absence dans un autre service', 'absence-notification',
      expect.objectContaining({ type_absence: type, entreprise_id: ent.id })
    );
  });

  it('ne donne aucun droit via le service de l’employé ou les permissions de congés', async () => {
    await ent.update({
      politique_conges: { service_policies: {
        RH: { manager_can_view_all_absences: true },
        IT: { manager_can_view_all_services: true, manager_can_validate_all_services: true },
      } },
    });
    await notifyAbsenceCreated(fakeAbsence(empRH.id), ent.id);
    expect(emailService.sendEmail.mock.calls.map(([to]) => to)).not.toContain(mgrIT.email);
  });

  it('exclut un manager inactif même avec le réglage activé', async () => {
    await ent.update({ politique_conges: { service_policies: { IT: { manager_can_view_all_absences: true } } } });
    await mgrIT.update({ statut: 'inactif' });
    try {
      await notifyAbsenceCreated(fakeAbsence(empRH.id), ent.id);
      expect(emailService.sendEmail.mock.calls.map(([to]) => to)).not.toContain(mgrIT.email);
    } finally {
      await mgrIT.update({ statut: 'actif' });
    }
  });
});
