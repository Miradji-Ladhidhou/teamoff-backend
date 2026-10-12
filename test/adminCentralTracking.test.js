'use strict';

const { seed } = require('./helpers/seed');
const { Utilisateur, CompteurConges, LeavePolicy, CongeActionRequest, Notification, Conge, Absence, sequelize } = require('../src/models');
const conges = require('../src/services/congesService');
const actions = require('../src/services/congeActionRequestService');
const absenceService = require('../src/services/absenceService');
const absenceController = require('../src/controllers/absenceController');
const notificationService = require('../src/services/notificationService');
const emailService = require('../src/services/emailService');
const { runPendingLeaveReminders, runReservationReminders } = require('../src/cron/emailCron');
const { notifyAdminsInformationEvent } = require('../src/services/managerEventNotificationService');
const dayjs = require('dayjs');
const sockets = require('../src/services/notificationSocketService');
const settingsService = require('../src/services/systemSettingsService');

let ctx, originalIo;
const year = dayjs().year() + 1;

beforeEach(async () => {
  ctx = await seed();
  originalIo = sockets.io;
  await ctx.manager.update({ service: 'Finance' });
  await ctx.employe.update({ service: 'Finance' });
  await CompteurConges.create({
    entreprise_id: ctx.entreprise.id, utilisateur_id: ctx.employe.id,
    conge_type_id: ctx.congeType.id, annee: year, jours_acquis: 25,
  });
  await LeavePolicy.create({
    entreprise_id: ctx.entreprise.id, allow_modify_validated: true,
    allow_cancel_validated: true, min_notice_days: 0,
  });
  jest.spyOn(notificationService, 'sendEmail').mockResolvedValue(undefined);
  jest.spyOn(emailService, 'sendEmail').mockResolvedValue(undefined);
  await configure();
});

afterEach(async () => {
  sockets.io = originalIo;
  jest.restoreAllMocks();
  await CongeActionRequest.destroy({ where: { entreprise_id: ctx.entreprise.id } });
  await LeavePolicy.destroy({ where: { entreprise_id: ctx.entreprise.id } });
  await ctx.cleanup();
});

async function configure(workflow = 'manager_admin', notification_settings = {}) {
  await ctx.entreprise.update({ politique_conges: {
    approval_workflow: workflow, notification_settings,
    blocked_days: { exclude_weekends: false, exclude_holidays: false },
  } });
}

function createLeave() {
  return conges.createConge({
    conge_type_id: ctx.congeType.id, reqUser: ctx.employe,
    date_debut: `${year}-09-01`, date_fin: `${year}-09-02`,
    commentaire_employe: 'Motif de test',
  });
}

function adminQueuedEmails() {
  return notificationService.sendEmail.mock.calls.map(([payload]) => payload)
    .filter(payload => payload.to === ctx.admin.email);
}

function adminInformationEmails() {
  return emailService.sendEmail.mock.calls.filter(([to]) => to === ctx.admin.email);
}

async function adminAlerts(type) {
  return Notification.findAll({ where: { utilisateur_id: ctx.admin.id, ...(type ? { type } : {}) } });
}

function clearEmails() {
  notificationService.sendEmail.mockClear();
  emailService.sendEmail.mockClear();
}

test.each([
  ['manager_admin', 'information', 'en_attente_manager'],
  ['manager_only', 'information', 'en_attente_manager'],
  ['admin_only', 'action', 'en_attente_manager'],
  ['auto', 'information', 'valide_final'],
])('création %s : un email admin %s, sans changer le statut %s', async (workflow, mode, status) => {
  await configure(workflow);
  const leave = await createLeave();
  expect(leave.statut).toBe(status);
  expect(adminQueuedEmails()).toHaveLength(1);
  expect(adminQueuedEmails()[0].data.notification_mode).toBe(mode);
  const alerts = await adminAlerts('conge_demande');
  expect(alerts).toHaveLength(1);
  expect(alerts[0].message).toMatch(mode === 'action' ? /^Action requise/ : /^Pour information/);
  if (workflow === 'manager_admin') {
    await expect(conges.validerConge(leave.id, ctx.admin)).rejects.toMatchObject({ statusCode: 400 });
  }
});

test('passage manager puis admin : un email à chaque étape, sans doubler la validation manager', async () => {
  const leave = await createLeave();
  clearEmails();
  await conges.validerConge(leave.id, ctx.manager);
  expect(adminQueuedEmails()).toHaveLength(1);
  expect(adminQueuedEmails()[0].data.notification_mode).toBe('action');
  expect(adminInformationEmails()).toHaveLength(0);
  const alerts = await adminAlerts('conge_valide_manager');
  expect(alerts).toHaveLength(1);
  expect(alerts[0].message).toMatch(/^Action requise/);
});

test.each(['manager_only', 'manager_admin'])('décision manager %s : email informatif de refus', async workflow => {
  await configure(workflow);
  const leave = await createLeave();
  clearEmails();
  await conges.rejeterConge(leave.id, ctx.manager, 'Refus manager');
  expect(adminInformationEmails()).toHaveLength(1);
  expect(adminInformationEmails()[0][3].notification_mode).toBe('information');
  expect((await adminAlerts('conge_decision_refus'))[0].message).toMatch(/^Pour information/);
});

test('validation finale manager-only : un suivi informatif, aucune étape admin ajoutée', async () => {
  await configure('manager_only');
  const leave = await createLeave();
  clearEmails();
  expect((await conges.validerConge(leave.id, ctx.manager)).statut).toBe('valide_final');
  expect(adminQueuedEmails()).toHaveLength(0);
  expect(adminInformationEmails()).toHaveLength(1);
});

test('modification et annulation salarié pendant l’attente manager : suivi admin sans action', async () => {
  const leave = await createLeave();
  clearEmails();
  await conges.updateConge(leave.id, { commentaire_employe: 'Nouveau motif' }, ctx.employe);
  expect(adminQueuedEmails()).toHaveLength(1);
  expect(adminQueuedEmails()[0].data.notification_mode).toBe('information');
  expect((await adminAlerts('conge_modifie_employe'))[0].message).toMatch(/^Pour information/);
  clearEmails();
  await conges.deleteConge(leave.id, ctx.employe);
  expect(adminQueuedEmails()).toHaveLength(1);
  expect(adminQueuedEmails()[0].data.notification_mode).toBe('information');
  expect((await adminAlerts('conge_annule_employe'))[0].message).toMatch(/^Pour information/);
});

test('le suivi admin ne donne pas au salarié le droit de modifier après validation manager', async () => {
  const leave = await createLeave();
  await conges.validerConge(leave.id, ctx.manager);
  clearEmails();
  await expect(conges.updateConge(leave.id, { commentaire_employe: 'Nouveau motif' }, ctx.employe))
    .rejects.toMatchObject({ statusCode: 409 });
  expect((await Conge.findByPk(leave.id)).statut).toBe('valide_manager');
  expect(adminQueuedEmails()).toHaveLength(0);
});

test.each(['en_attente_manager', 'valide_manager'])('relance %s : email admin et une alerte persistante par jour', async status => {
  const leave = await createLeave();
  clearEmails();
  jest.spyOn(Conge, 'findAll').mockResolvedValue([{
    ...leave, statut: status, created_at: dayjs().subtract(3, 'day').toDate(),
    updated_at: dayjs().subtract(3, 'day').toDate(),
    utilisateur: ctx.employe.toJSON(), conge_type: ctx.congeType.toJSON(),
  }]);
  await runPendingLeaveReminders();
  expect(adminInformationEmails()).toHaveLength(1);
  expect(adminInformationEmails()[0][3].notification_mode).toBe(status === 'valide_manager' ? 'action' : 'information');
  await runPendingLeaveReminders();
  const alerts = await adminAlerts('conge_rappel_en_attente');
  expect(alerts).toHaveLength(1);
  expect(alerts[0].message).toMatch(status === 'valide_manager' ? /^Action requise/ : /^Pour information/);
});

test('réservation manager-only : création et rappel admin informatifs et idempotents', async () => {
  await configure('manager_only');
  await CompteurConges.update({ jours_acquis: 0 }, { where: { utilisateur_id: ctx.employe.id } });
  const leave = await createLeave();
  expect(leave.statut).toBe('reserve');
  expect(adminQueuedEmails()).toHaveLength(1);
  expect(adminQueuedEmails()[0].data.notification_mode).toBe('information');
  expect(await adminAlerts('conge_reservation_creee')).toHaveLength(1);
  const stored = await Conge.findByPk(leave.id);
  const target = dayjs().add(30, 'day').format('YYYY-MM-DD');
  await stored.update({ date_debut: target, date_fin: target });
  clearEmails();
  const reserved = { ...stored.toJSON(), utilisateur: ctx.employe.toJSON(), conge_type: ctx.congeType.toJSON() };
  jest.spyOn(Conge, 'findAll').mockImplementation(async ({ where }) => where.date_debut === target ? [reserved] : []);
  await Promise.all([runReservationReminders(), runReservationReminders()]);
  expect(adminInformationEmails()).toHaveLength(1);
  expect(adminInformationEmails()[0][3].notification_mode).toBe('information');
  expect(await adminAlerts('conge_rappel_reservation')).toHaveLength(1);
});

test.each([false, true])('activation automatique=%s : l’admin informé tant que le manager doit agir', async automatic => {
  await CompteurConges.update({ jours_acquis: 0 }, { where: { utilisateur_id: ctx.employe.id } });
  const leave = await createLeave();
  await CompteurConges.update({ jours_acquis: 25 }, {
    where: { utilisateur_id: ctx.employe.id, annee: year },
  });
  clearEmails();
  if (automatic) await conges.tryActivateReservations(ctx.employe.id, ctx.congeType.id, year);
  else await conges.activerReservation(leave.id, ctx.admin);
  expect((await Conge.findByPk(leave.id)).statut).toBe('en_attente_manager');
  expect(adminQueuedEmails()).toHaveLength(1);
  expect(adminQueuedEmails()[0].data.notification_mode).toBe('information');
});

test('demandes formelles : suivi manager-only et décision manager sans double email admin', async () => {
  await configure('manager_only');
  const leave = await createLeave();
  await conges.validerConge(leave.id, ctx.manager);
  clearEmails();
  const pending = await actions.submitRequest({
    congeId: leave.id, type: 'modify', commentaire: 'Modification', user: ctx.employe,
    date_debut_demandee: `${year}-09-03`, date_fin_demandee: `${year}-09-04`,
  });
  expect(adminQueuedEmails()).toHaveLength(1);
  expect(adminQueuedEmails()[0].data.notification_mode).toBe('information');
  expect((await adminAlerts('conge_action_request'))[0].message).toMatch(/^Pour information/);
  clearEmails();
  await actions.approveRequest(pending.id, { commentaire: 'Accord', adminUser: ctx.manager });
  expect(adminQueuedEmails()).toHaveLength(1);
  expect(adminInformationEmails()).toHaveLength(0);
  expect((await adminAlerts('conge_action_approved'))[0].message).toMatch(/^Pour information/);
});

test.each(['maladie', 'absence_exceptionnelle'])('absence %s : déclaration, modification, statut et suppression informatifs', async type_absence => {
  const absence = await Absence.create({
    entreprise_id: ctx.entreprise.id, utilisateur_id: ctx.employe.id, type_absence,
    date_debut: `${year}-10-01`, date_fin: `${year}-10-02`, commentaire: 'Motif privé',
  });
  await absenceService.notifyAbsenceCreated(absence, ctx.entreprise.id);
  expect(adminInformationEmails()).toHaveLength(1);
  expect(await adminAlerts('absence_declaree')).toHaveLength(1);
  clearEmails();
  const res = { json: jest.fn() };
  const next = jest.fn();
  await absenceController.updateAbsence({
    params: { id: absence.id }, body: { commentaire: 'Nouveau motif' }, user: ctx.employe,
  }, res, next);
  expect(next).not.toHaveBeenCalled();
  expect(adminInformationEmails()).toHaveLength(1);
  expect(await adminAlerts('absence_modifiee')).toHaveLength(1);
  clearEmails();
  await absenceController.updateAbsence({
    params: { id: absence.id }, body: { statut: 'approuvée' }, user: ctx.manager,
  }, res, next);
  expect(next).not.toHaveBeenCalled();
  expect(adminInformationEmails()).toHaveLength(1);
  expect(await adminAlerts('absence_statut_modifie')).toHaveLength(1);
  clearEmails();
  await absenceService.deleteAbsence(absence.id, ctx.manager);
  expect(adminInformationEmails()).toHaveLength(1);
  expect(await adminAlerts('absence_supprimee')).toHaveLength(1);
});

test('suivi des autres admins : actifs, même entreprise, sans notification à l’auteur', async () => {
  const peer = await Utilisateur.create({
    entreprise_id: ctx.entreprise.id, role: 'admin_entreprise', statut: 'actif',
    prenom: 'Autre', nom: 'Admin', email: `peer.${ctx.entreprise.id}@test.internal`,
    password_hash: ctx.admin.password_hash,
  });
  const inactive = await Utilisateur.create({
    entreprise_id: ctx.entreprise.id, role: 'admin_entreprise', statut: 'inactif',
    prenom: 'Inactif', nom: 'Admin', email: `inactive.${ctx.entreprise.id}@test.internal`,
    password_hash: ctx.admin.password_hash,
  });
  const recipients = await require('../src/services/leaveNotificationRecipients').getLeaveNotificationRecipients({
    entrepriseId: ctx.entreprise.id, service: 'Finance', workflow: 'manager_admin',
  });
  expect(recipients.filter(user => user.role === 'admin_entreprise').map(user => user.id).sort())
    .toEqual([ctx.admin.id, peer.id].sort());
  await notifyAdminsInformationEvent({
    entrepriseId: ctx.entreprise.id, type: 'decision', message: 'Décision terminée',
    url: '/conges', excludeUserIds: [ctx.admin.id],
  });
  expect(adminInformationEmails()).toHaveLength(0);
  expect(emailService.sendEmail.mock.calls.map(([to]) => to)).toEqual([peer.email]);
  expect(await Notification.count({ where: { utilisateur_id: inactive.id } })).toBe(0);
});

test('options création et validation désactivées : pas de suivi email ou application supplémentaire', async () => {
  await configure('manager_admin', { on_create: false, on_validate: false });
  const leave = await createLeave();
  expect(adminQueuedEmails()).toHaveLength(0);
  expect(await adminAlerts()).toHaveLength(0);
  await conges.validerConge(leave.id, ctx.manager);
  expect(adminQueuedEmails()).toHaveLength(0);
  expect(adminInformationEmails()).toHaveLength(0);
  expect(await adminAlerts()).toHaveLength(0);
});

test.each([false, true])('activation automatique=%s en workflow auto : validation et suivi admin informatifs', async automatic => {
  await configure('auto');
  await CompteurConges.update({ jours_acquis: 0 }, { where: { utilisateur_id: ctx.employe.id } });
  const leave = await createLeave();
  await CompteurConges.update({ jours_acquis: 25 }, {
    where: { utilisateur_id: ctx.employe.id, annee: year },
  });
  clearEmails();
  if (automatic) await conges.tryActivateReservations(ctx.employe.id, ctx.congeType.id, year);
  else await conges.activerReservation(leave.id, ctx.admin);
  expect((await Conge.findByPk(leave.id)).statut).toBe('valide_final');
  expect(adminInformationEmails()).toHaveLength(1);
  expect(adminInformationEmails()[0][3].notification_mode).toBe('information');
  expect(await adminAlerts('conge_reserve_active')).toHaveLength(1);
});

test('rollback du suivi : aucune alerte enregistrée ni aucun email envoyé', async () => {
  await expect(sequelize.transaction(async transaction => {
    await notifyAdminsInformationEvent({
      entrepriseId: ctx.entreprise.id, type: 'rollback_test',
      message: 'Événement non confirmé', url: '/conges', transaction,
    });
    expect(adminInformationEmails()).toHaveLength(0);
    throw new Error('Annulation transaction');
  })).rejects.toThrow('Annulation transaction');
  expect(await adminAlerts('rollback_test')).toHaveLength(0);
  expect(adminInformationEmails()).toHaveLength(0);
});

test('isolation entreprise : aucun suivi transmis aux admins d’une autre entreprise', async () => {
  const other = await seed();
  try {
    await notifyAdminsInformationEvent({
      entrepriseId: ctx.entreprise.id, type: 'isolation_test',
      message: 'Événement entreprise locale', url: '/conges',
    });
    expect(emailService.sendEmail.mock.calls.map(([to]) => to)).toEqual([ctx.admin.email]);
    expect(await Notification.count({ where: { utilisateur_id: other.admin.id } })).toBe(0);
  } finally {
    await other.cleanup();
  }
});

test('temps réel admin : information à la création, action après manager, information après refus', async () => {
  const leave = await createLeave();
  sockets.io = {};
  jest.spyOn(settingsService, 'getSettings').mockResolvedValue({ pushNotifications: true });
  const notify = jest.spyOn(sockets, 'notifyUser').mockReturnValue(true);
  await sockets.notifyCompany(ctx.entreprise.id, 'conge-created', { conge: leave });
  expect(notify.mock.calls.find(([id]) => id === ctx.admin.id)[2].notification_mode).toBe('information');
  const decision = await conges.validerConge(leave.id, ctx.manager);
  notify.mockClear();
  await sockets.notifyCompany(ctx.entreprise.id, 'conge-status-changed', { conge: decision, action: 'validated' });
  expect(notify.mock.calls.find(([id]) => id === ctx.admin.id)[2].notification_mode).toBe('action');
  const refused = await conges.rejeterConge(leave.id, ctx.admin, 'Refus admin');
  notify.mockClear();
  await sockets.notifyCompany(ctx.entreprise.id, 'conge-status-changed', { conge: refused, action: 'rejected' });
  expect(notify.mock.calls.find(([id]) => id === ctx.admin.id)[2].notification_mode).toBe('information');
});

test.each(['validation', 'refus', 'modification', 'annulation'])('décision admin %s : seul l’autre admin reçoit un suivi, sans doublon manager', async action => {
  const peer = await Utilisateur.create({
    entreprise_id: ctx.entreprise.id, role: 'admin_entreprise', statut: 'actif',
    prenom: 'Autre', nom: 'Admin', email: `peer.${ctx.entreprise.id}@test.internal`,
    password_hash: ctx.admin.password_hash,
  });
  const leave = await createLeave();
  await conges.validerConge(leave.id, ctx.manager);
  if (['modification', 'annulation'].includes(action)) await conges.validerConge(leave.id, ctx.admin);
  clearEmails();
  if (action === 'validation') await conges.validerConge(leave.id, ctx.admin);
  if (action === 'refus') await conges.rejeterConge(leave.id, ctx.admin, 'Refus');
  if (action === 'modification') await conges.updateConge(leave.id, { commentaire_employe: 'Modification admin' }, ctx.admin);
  if (action === 'annulation') await conges.deleteConge(leave.id, ctx.admin, { commentaire: 'Annulation admin' });
  expect(adminQueuedEmails()).toHaveLength(0);
  expect(adminInformationEmails()).toHaveLength(0);
  expect(notificationService.sendEmail.mock.calls.filter(([payload]) => payload.to === peer.email)).toHaveLength(0);
  expect(emailService.sendEmail.mock.calls.filter(([to]) => to === peer.email)).toHaveLength(1);
});

test('décision sur une demande formelle : un seul suivi à l’autre admin', async () => {
  const peer = await Utilisateur.create({
    entreprise_id: ctx.entreprise.id, role: 'admin_entreprise', statut: 'actif',
    prenom: 'Autre', nom: 'Admin', email: `peer.${ctx.entreprise.id}@test.internal`,
    password_hash: ctx.admin.password_hash,
  });
  const leave = await createLeave();
  await conges.validerConge(leave.id, ctx.manager);
  await conges.validerConge(leave.id, ctx.admin);
  const pending = await actions.submitRequest({
    congeId: leave.id, type: 'modify', commentaire: 'Modification', user: ctx.employe,
    date_debut_demandee: `${year}-09-03`, date_fin_demandee: `${year}-09-04`,
  });
  clearEmails();
  await actions.approveRequest(pending.id, { commentaire: 'Accord admin', adminUser: ctx.admin });
  expect(adminInformationEmails()).toHaveLength(0);
  expect(emailService.sendEmail.mock.calls.filter(([to]) => to === peer.email)).toHaveLength(1);
  expect(await Notification.count({ where: { utilisateur_id: peer.id, type: 'conge_modifie' } })).toBe(0);
  expect(await Notification.count({ where: { utilisateur_id: peer.id, type: 'conge_action_approved' } })).toBe(1);
});
