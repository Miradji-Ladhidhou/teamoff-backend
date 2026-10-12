'use strict';

const { seed } = require('./helpers/seed');
const { Utilisateur, CompteurConges, LeavePolicy, CongeActionRequest, Notification, Conge } = require('../src/models');
const conges = require('../src/services/congesService');
const actions = require('../src/services/congeActionRequestService');
const notificationService = require('../src/services/notificationService');
const emailService = require('../src/services/emailService');
const sockets = require('../src/services/notificationSocketService');
const settingsService = require('../src/services/systemSettingsService');
const dayjs = require('dayjs');
const { runPendingLeaveReminders, runReservationReminders } = require('../src/cron/emailCron');

let ctx, crossManager, originalIo;
const nextYear = dayjs().year() + 1;

beforeEach(async () => {
  ctx = await seed();
  await ctx.manager.update({ service: 'Finance' });
  await ctx.employe.update({ service: 'Finance' });
  crossManager = await Utilisateur.create({
    entreprise_id: ctx.entreprise.id, prenom: 'Manager', nom: 'IT', role: 'manager', statut: 'actif',
    service: 'IT', email: `cross.flow.${ctx.entreprise.id}@test.internal`, password_hash: ctx.manager.password_hash,
  });
  await CompteurConges.create({
    entreprise_id: ctx.entreprise.id, utilisateur_id: ctx.employe.id,
    conge_type_id: ctx.congeType.id, annee: nextYear, jours_acquis: 25,
  });
  await LeavePolicy.create({
    entreprise_id: ctx.entreprise.id, allow_modify_validated: true, allow_cancel_validated: true,
  });
  jest.spyOn(notificationService, 'sendEmail').mockResolvedValue(undefined);
  jest.spyOn(emailService, 'sendEmail').mockResolvedValue(undefined);
  originalIo = sockets.io;
});

afterEach(async () => {
  sockets.io = originalIo;
  jest.restoreAllMocks();
  await CongeActionRequest.destroy({ where: { entreprise_id: ctx.entreprise.id } });
  await LeavePolicy.destroy({ where: { entreprise_id: ctx.entreprise.id } });
  await ctx.cleanup();
});

async function configure(config, notificationSettings = {}) {
  await ctx.entreprise.update({ politique_conges: {
    approval_workflow: 'manager_admin',
    blocked_days: { exclude_weekends: false, exclude_holidays: false },
    notification_settings: notificationSettings,
    service_policies: { IT: { manager_cross_service: { conges: config } } },
  } });
}

function createLeave() {
  return conges.createConge({
    conge_type_id: ctx.congeType.id, reqUser: ctx.employe,
    date_debut: `${nextYear}-09-01`, date_fin: `${nextYear}-09-02`, commentaire_employe: 'Motif privé',
  });
}

function crossEmails() {
  return notificationService.sendEmail.mock.calls.map(([payload]) => payload).filter(payload => payload.to === crossManager.email);
}

test.each([
  [true, false, 'information'],
  [false, true, 'information'],
  [true, true, 'action'],
])('création réelle : email=%s application=%s participation=%s et refus effectif des actions informatives', async (email, in_app, participation) => {
  await configure({ view: participation === 'action', email, in_app, participation });
  const leave = await createLeave();
  expect(crossEmails()).toHaveLength(email ? 1 : 0);
  if (email) expect(crossEmails()[0].data.notification_mode).toBe(participation);
  const notifications = await Notification.findAll({ where: { utilisateur_id: crossManager.id } });
  expect(notifications).toHaveLength(in_app ? 1 : 0);
  if (in_app) expect(notifications[0].message).toMatch(participation === 'action' ? /^Action requise/ : /^Pour information/);
  expect(notificationService.sendEmail.mock.calls.filter(([payload]) => payload.to === ctx.manager.email)).toHaveLength(1);
  if (participation === 'information') {
    await expect(conges.validerConge(leave.id, crossManager)).rejects.toMatchObject({ statusCode: 403 });
    await expect(conges.rejeterConge(leave.id, crossManager)).rejects.toMatchObject({ statusCode: 403 });
    await expect(conges.getCongeById(leave.id, crossManager)).rejects.toMatchObject({ statusCode: 403 });
  } else {
    const decision = await conges.validerConge(leave.id, crossManager);
    expect(decision.statut).toBe('valide_manager');
  }
});

test('la modification et la demande d’annulation arrivent en application seule, sans faux email', async () => {
  await configure({ view: true, email: false, in_app: true, participation: 'information' });
  const leave = await createLeave();
  await conges.updateConge(leave.id, { commentaire_employe: 'Nouveau motif privé' }, ctx.employe);
  expect(crossEmails()).toHaveLength(0);
  const update = await Notification.findOne({ where: { utilisateur_id: crossManager.id, type: 'conge_modifie_employe' } });
  expect(update.message).toMatch(/^Pour information/);
  expect(update.message).not.toContain('motif privé');
  await conges.validerConge(leave.id, ctx.manager);
  await conges.validerConge(leave.id, ctx.admin);
  const actionRequest = await actions.submitRequest({
    congeId: leave.id, type: 'cancel', commentaire: 'Annulation privée', user: ctx.employe,
  });
  const pending = await Notification.findOne({ where: { utilisateur_id: crossManager.id, type: 'conge_action_request' } });
  expect(pending.message).toMatch(/^Pour information/);
  await expect(actions.approveRequest(actionRequest.id, { commentaire: 'Non autorisé', adminUser: crossManager }))
    .rejects.toMatchObject({ statusCode: 403 });
  await actions.rejectRequest(actionRequest.id, { commentaire: 'Décision admin', adminUser: ctx.admin });
  expect((await Notification.findOne({ where: { utilisateur_id: crossManager.id, type: 'conge_action_rejected' } })).message)
    .toMatch(/^Pour information/);
  const modification = await actions.submitRequest({
    congeId: leave.id, type: 'modify', commentaire: 'Modification privée', user: ctx.employe,
    date_debut_demandee: `${nextYear}-09-03`, date_fin_demandee: `${nextYear}-09-04`,
  });
  await actions.approveRequest(modification.id, { commentaire: 'Décision admin', adminUser: ctx.admin });
  const approved = await Notification.findAll({ where: { utilisateur_id: crossManager.id, type: 'conge_action_approved' } });
  expect(approved).toHaveLength(1);
  expect(approved[0].message).toMatch(/^Pour information/);
  expect(crossEmails()).toHaveLength(0);
  expect(emailService.sendEmail.mock.calls.filter(([to]) => to === crossManager.email)).toHaveLength(0);
});

test('décisions réelles : un seul email informatif par décision, sans action après passage à l’admin', async () => {
  await configure({ view: true, email: true, in_app: true, participation: 'action' });
  const leave = await createLeave();
  emailService.sendEmail.mockClear();
  await conges.validerConge(leave.id, ctx.manager);
  expect(emailService.sendEmail.mock.calls.filter(([to]) => to === crossManager.email)).toHaveLength(1);
  expect(emailService.sendEmail.mock.calls.find(([to]) => to === crossManager.email)[3].notification_mode).toBe('information');
  const event = await Notification.findOne({ where: { utilisateur_id: crossManager.id, type: 'conge_decision_manager' } });
  expect(event.message).toMatch(/^Pour information/);
  await expect(conges.validerConge(leave.id, crossManager)).rejects.toThrow();
  emailService.sendEmail.mockClear();
  await conges.rejeterConge(leave.id, ctx.admin, 'Motif admin privé');
  expect(emailService.sendEmail.mock.calls.filter(([to]) => to === crossManager.email)).toHaveLength(1);
  const refused = await Notification.findAll({ where: { utilisateur_id: crossManager.id, type: 'conge_decision_refus' } });
  expect(refused).toHaveLength(1);
  expect(refused[0].message).not.toContain('Motif admin privé');
});

test('le flag de création existant bloque emails et notifications, sans perdre la déclaration', async () => {
  await configure({ view: true, email: true, in_app: true, participation: 'action' }, { on_create: false });
  const leave = await createLeave();
  expect(leave.statut).toBe('en_attente_manager');
  expect(crossEmails()).toHaveLength(0);
  expect(await Notification.count({ where: { utilisateur_id: crossManager.id } })).toBe(0);
  sockets.io = {};
  jest.spyOn(settingsService, 'getSettings').mockResolvedValue({ pushNotifications: true });
  const notify = jest.spyOn(sockets, 'notifyUser').mockReturnValue(true);
  await sockets.notifyCompany(ctx.entreprise.id, 'conge-created', { conge: leave });
  expect(notify).not.toHaveBeenCalled();
});

test('le temps réel respecte le canal et n’annonce aucune action sur une suppression', async () => {
  await configure({ view: true, email: true, in_app: false, participation: 'action' });
  const leave = await createLeave();
  sockets.io = {};
  jest.spyOn(settingsService, 'getSettings').mockResolvedValue({ pushNotifications: true });
  const notify = jest.spyOn(sockets, 'notifyUser').mockReturnValue(true);
  await sockets.notifyCompany(ctx.entreprise.id, 'conge-created', { conge: leave });
  expect(notify.mock.calls.some(([id]) => id === crossManager.id)).toBe(false);
  await configure({ view: true, email: false, in_app: true, participation: 'action' });
  notify.mockClear();
  await sockets.notifyCompany(ctx.entreprise.id, 'conge-created', { conge: leave });
  expect(notify.mock.calls.find(([id]) => id === crossManager.id)[2].notification_mode).toBe('action');
  notify.mockClear();
  await sockets.notifyCompany(ctx.entreprise.id, 'conge-deleted', { conge: leave });
  expect(notify.mock.calls.find(([id]) => id === crossManager.id)[2].notification_mode).toBe('information');
  settingsService.getSettings.mockResolvedValue({ pushNotifications: false });
  notify.mockClear();
  await sockets.notifyCompany(ctx.entreprise.id, 'conge-created', { conge: leave });
  expect(notify).not.toHaveBeenCalled();
});

test('les rappels en application seule sont informatifs et dédupliqués sur la journée', async () => {
  await configure({ view: false, email: false, in_app: true, participation: 'information' });
  const leave = await createLeave();
  const pending = {
    ...leave, created_at: dayjs().subtract(3, 'day').toDate(),
    utilisateur: ctx.employe.toJSON(), conge_type: ctx.congeType.toJSON(),
  };
  jest.spyOn(Conge, 'findAll').mockResolvedValue([pending]);
  await runPendingLeaveReminders();
  await runPendingLeaveReminders();
  const reminders = await Notification.findAll({ where: { utilisateur_id: crossManager.id, type: 'conge_rappel_en_attente' } });
  expect(reminders).toHaveLength(1);
  expect(reminders[0].message).toMatch(/^Pour information/);
  expect(reminders[0].url).toBeNull();
  expect(emailService.sendEmail.mock.calls.filter(([to]) => to === crossManager.email)).toHaveLength(0);
});

test('les rappels de réservation en application seule restent idempotents en concurrence', async () => {
  await configure({ view: true, email: false, in_app: true, participation: 'information' });
  await CompteurConges.update({ jours_acquis: 0 }, { where: { utilisateur_id: ctx.employe.id } });
  const leave = await createLeave();
  expect(leave.statut).toBe('reserve');
  const targetDate = dayjs().add(30, 'day').format('YYYY-MM-DD');
  const storedLeave = await Conge.findByPk(leave.id);
  await storedLeave.update({ date_debut: targetDate, date_fin: targetDate });
  const reserved = { ...storedLeave.toJSON(), utilisateur: ctx.employe.toJSON(), conge_type: ctx.congeType.toJSON() };
  jest.spyOn(Conge, 'findAll').mockImplementation(async ({ where }) => where.date_debut === targetDate ? [reserved] : []);
  await Promise.all([runReservationReminders(), runReservationReminders()]);
  const reminders = await Notification.findAll({ where: { utilisateur_id: crossManager.id, type: 'conge_rappel_reservation' } });
  expect(reminders).toHaveLength(1);
  expect(reminders[0].message).toMatch(/^Pour information/);
  expect(emailService.sendEmail.mock.calls.filter(([to]) => to === crossManager.email)).toHaveLength(0);
});
