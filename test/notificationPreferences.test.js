'use strict';

const request = require('supertest');
const dayjs = require('dayjs');
const { seed } = require('./helpers/seed');
const { generateToken } = require('./helpers/auth');
const app = require('../src/index');
const { Utilisateur, CompteurConges, Notification, NotificationDelivery, Entreprise, Conge, Absence, CongeActionRequest, AuditLog } = require('../src/models');
const conges = require('../src/services/congesService');
const absences = require('../src/services/absenceService');
const notifications = require('../src/services/notificationService');
const emails = require('../src/services/emailService');
const settings = require('../src/services/systemSettingsService');
const preferences = require('../src/services/notificationPreferencesService');
const { withContext, sendConfiguredEmail } = require('../src/services/businessNotificationContext');
const { prepareEmailNotificationMode } = require('../src/utils/emailNotificationMode');
const sockets = require('../src/services/notificationSocketService');

let ctx, other, manager2, admin2, outsider, apprentice;
const year = dayjs().year() + 1;

beforeEach(async () => {
  ctx = await seed();
  other = await Entreprise.create({ nom: 'Autre entreprise notification', statut: 'active' });
  await ctx.manager.update({ service: 'RH' });
  await ctx.employe.update({ service: 'RH' });
  await ctx.admin.update({ service: 'Finance' });
  const add = (role, service, company = ctx.entreprise.id) => Utilisateur.create({
    entreprise_id: company, role, service, statut: 'actif', prenom: role, nom: service,
    email: `${role}.${service}.${company}.${Date.now()}@test.internal`, password_hash: ctx.manager.password_hash,
  });
  manager2 = await add('manager', 'RH');
  admin2 = await add('admin_entreprise', 'RH');
  outsider = await add('manager', 'Finance');
  apprentice = await add('apprenti', 'RH');
  await CompteurConges.bulkCreate([ctx.employe, apprentice].map(user => ({
    entreprise_id: ctx.entreprise.id, utilisateur_id: user.id, conge_type_id: ctx.congeType.id,
    annee: year, jours_acquis: 25,
  })));
  await ctx.entreprise.update({
    politique_conges: {
      approval_workflow: 'manager_admin',
      blocked_days: { exclude_weekends: false, exclude_holidays: false },
      service_policies: { RH: { approval_workflow: 'manager_admin' }, Finance: { approval_workflow: 'manager_admin' } },
    },
  });
  jest.spyOn(notifications, 'sendEmailLegacy').mockResolvedValue({ success: true });
  jest.spyOn(emails, 'sendEmailLegacy').mockResolvedValue({ success: true });
  jest.spyOn(settings, 'getSettings').mockResolvedValue({ emailNotifications: true, pushNotifications: false });
});

afterEach(async () => {
  jest.restoreAllMocks();
  await ctx.cleanup();
  await other.destroy();
});

const channels = (email, in_app) => ({ email, in_app });
const config = roles => ({ version: 1, roles });
const create = (user = ctx.employe) => conges.createConge({
  reqUser: user, conge_type_id: ctx.congeType.id,
  date_debut: `${year}-09-01`, date_fin: `${year}-09-02`, commentaire_employe: 'Commentaire privé',
});

test.each(['company', 'service'])('liste workflow %s : mêmes canaux, type personnalisé selon l’étape et sans doublon', async scope => {
  const roles = {
    manager: { leave_created: { workflow: channels(true, true) }, leave_manager_validated: { workflow: channels(true, true) } },
    admin_entreprise: { leave_created: { workflow: channels(true, true) }, leave_manager_validated: { workflow: channels(true, true) } },
    employe: { leave_created: { workflow: channels(false, true) } },
  };
  await preferences.updateConfiguration(ctx.entreprise.id, { preferences: scope === 'company'
    ? config(roles) : { ...config({}), service_roles: { RH: roles } },
  }, ctx.admin.id);
  const leave = await create();
  await settleEmailWork();
  const mails = notifications.sendEmailLegacy.mock.calls.map(([payload]) => payload)
    .filter(mail => mail.templateName === 'leave-new-request-manager');
  for (const manager of [ctx.manager, manager2]) {
    const sent = mails.filter(mail => mail.to === manager.email);
    expect(sent).toHaveLength(1);
    expect(sent[0].data).toMatchObject({ notification_mode: 'action', destinataire_role: 'manager' });
  }
  for (const admin of [ctx.admin, admin2]) {
    const sent = mails.filter(mail => mail.to === admin.email);
    expect(sent).toHaveLength(1);
    expect(sent[0].data).toMatchObject({ notification_mode: 'information', destinataire_role: 'admin_entreprise' });
  }
  expect(leave.statut).toBe('en_attente_manager');
  expect(mails.some(mail => mail.to === outsider.email)).toBe(false);
  notifications.sendEmailLegacy.mockClear();
  await conges.validerConge(leave.id, ctx.manager);
  await settleEmailWork();
  const nextStage = notifications.sendEmailLegacy.mock.calls.map(([payload]) => payload)
    .filter(mail => mail.templateName === 'leave-manager-approved-admin');
  for (const admin of [ctx.admin, admin2]) {
    const sent = nextStage.filter(mail => mail.to === admin.email);
    expect(sent).toHaveLength(1);
    expect(sent[0].data.notification_mode).toBe('action');
  }
  expect((await Conge.findByPk(leave.id)).statut).toBe('valide_manager');
});

test('commentaires congés : fiches, listes, calendrier, historique, attestations et demandes formelles sont filtrés côté API', async () => {
  await preferences.updateConfiguration(ctx.entreprise.id, { preferences: {
    ...config({}), comment_reading: { admin_entreprise: { conges: false }, manager: { conges: false } },
  } }, ctx.admin.id);
  const leave = await create();
  await settleEmailWork();
  await Conge.update({ statut: 'valide_final', commentaire_manager: 'Décision privée' }, { where: { id: leave.id } });
  const action = await CongeActionRequest.create({
    entreprise_id: ctx.entreprise.id, utilisateur_id: ctx.employe.id, conge_id: leave.id,
    type: 'cancel', commentaire_employe: 'Motif privé', commentaire_admin: 'Avis privé',
  });
  await AuditLog.create({ entreprise_id: ctx.entreprise.id, entity: 'Conge', entity_id: leave.id,
    action: 'CONGE_UPDATED', metadata: { updates: { commentaire_employe: 'Historique privé' } } });
  const get = (url, user = ctx.admin) => request(app).get(url).set('Authorization', `Bearer ${generateToken(user)}`).expect(200);
  for (const reader of [ctx.admin, ctx.manager]) {
    const detail = await get(`/api/conges/${leave.id}`, reader);
    expect(detail.body).toMatchObject({ commentaire_employe: null, commentaire_manager: null });
    const list = await get('/api/conges', reader);
    expect(list.body.items.find(item => item.id === leave.id).commentaire_employe).toBeNull();
    const calendar = await get('/api/calendrier-conges', reader);
    expect(calendar.body.find(item => item.id === leave.id).commentaire_employe).toBeNull();
    const certificate = await get(`/api/conges/${leave.id}/attestation`, reader);
    expect(certificate.body.conge.commentaire_employe).toBe('');
    const requestDetail = await get(`/api/conges/action-requests/${action.id}`, reader);
    expect(requestDetail.body.commentaire_employe).toBeNull();
    const history = await get(`/api/conges/${leave.id}/history`, reader);
    expect(JSON.stringify(history.body)).not.toContain('Historique privé');
  }
  const owner = await get(`/api/conges/${leave.id}`, ctx.employe);
  expect(owner.body.commentaire_employe).toBe('Commentaire privé');
  expect((await Conge.findByPk(leave.id)).commentaire_manager).toBe('Décision privée');
});

test.each(['absence_exceptionnelle', 'maladie'])('lecture %s : API et HTML email respectent la restriction, sans supprimer les déclarations', async category => {
  const event = category === 'maladie' ? 'sickness_created' : 'absence_created';
  await preferences.updateConfiguration(ctx.entreprise.id, { preferences: {
    ...config({
      manager: { [event]: { workflow: channels(true, true) } },
      admin_entreprise: { [event]: { workflow: channels(true, true) } },
    }),
    comment_reading: { manager: { [category]: false }, admin_entreprise: { [category]: false } },
  } }, ctx.admin.id);
  const absence = await absences.createAbsence({
    utilisateur_id: ctx.employe.id, entreprise_id: ctx.entreprise.id, type_absence: category,
    date_debut: `${year}-08-01`, date_fin: `${year}-08-02`, commentaire: 'Motif confidentiel',
  });
  await settleEmailWork();
  const mails = emails.sendEmailLegacy.mock.calls.filter(([to]) => [ctx.manager.email, manager2.email, ctx.admin.email, admin2.email].includes(to));
  expect(mails).toHaveLength(4);
  for (const [, , , data] of mails) expect(JSON.stringify(data)).not.toContain('Motif confidentiel');
  for (const reader of [ctx.admin, ctx.manager]) {
    const response = await request(app).get('/api/absences').set('Authorization', `Bearer ${generateToken(reader)}`).expect(200);
    expect(response.body.find(item => item.id === absence.id).commentaire).toBeNull();
  }
  expect((await Absence.findByPk(absence.id)).commentaire).toBe('Motif confidentiel');
});

test('la restriction de commentaires seule filtre un email d’action sans changer ses canaux historiques', async () => {
  await preferences.updateConfiguration(ctx.entreprise.id, { preferences: {
    ...config({}), comment_reading: { manager: { conges: false } },
  } }, ctx.admin.id);
  await create();
  await settleEmailWork();
  const mail = notifications.sendEmailLegacy.mock.calls.map(([payload]) => payload).find(payload => payload.to === ctx.manager.email);
  expect(mail).toBeDefined();
  expect(mail.data.commentaire_employe).toBeNull();
  expect(mail.data.notification_mode).toBe('action');
});

async function waitForEmails(count) {
  const deadline = Date.now() + 5000;
  while (notifications.sendEmailLegacy.mock.calls.length < count && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  expect(notifications.sendEmailLegacy.mock.calls).toHaveLength(count);
}

test.each(preferences.EVENTS.filter(event => event.requiresChannel))('interdit les deux canaux désactivés uniquement pour le nouveau réglage action $id', event => {
  expect(() => preferences.validatePreferences(config({
    manager: { [event.id]: { action: channels(false, false) } },
  }), [], [])).toThrow(/Au moins un canal/);
  expect(() => preferences.validatePreferences(config({
    manager: { [event.id]: { information: channels(false, false) } },
  }), [], [])).not.toThrow();
  expect(() => preferences.validatePreferences(config({}), [], [])).not.toThrow();
});

test('la configuration préserve les anciennes valeurs et tous les droits interservices', async () => {
  await ctx.entreprise.update({ politique_conges: {
    ...ctx.entreprise.politique_conges,
    notification_settings: { on_create: false, on_validate: false, on_reject: false },
    service_policies: { RH: {
      approval_workflow: 'manager_only',
      manager_cross_service: { conges: { view: true, participation: 'action', email: false, in_app: false } },
    } },
  } });
  const before = JSON.parse(JSON.stringify(ctx.entreprise.politique_conges));
  const legacy = await preferences.getConfiguration(ctx.entreprise.id);
  expect(legacy.legacy).toEqual({ on_create: false, on_validate: false, on_reject: false });
  await preferences.updateConfiguration(ctx.entreprise.id, {
    preferences: config({}),
    manager_services: { RH: { conges: channels(false, false) } },
  }, ctx.admin.id);
  await ctx.entreprise.reload();
  expect(ctx.entreprise.politique_conges.service_policies.RH.approval_workflow).toBe('manager_only');
  expect(ctx.entreprise.politique_conges.service_policies.RH.manager_cross_service.conges).toEqual(before.service_policies.RH.manager_cross_service.conges);
  expect(ctx.entreprise.politique_conges.notification_settings).toEqual(before.notification_settings);
});

test.each(['on_create', 'on_validate', 'on_reject'])('API : réactiver %s conserve les autres coupures, les préférences et le circuit', async key => {
  const legacy = { on_create: false, on_validate: false, on_reject: false };
  await ctx.entreprise.update({ politique_conges: {
    ...ctx.entreprise.politique_conges, notification_settings: legacy,
  }, parametres: { notifications: config({
    admin_entreprise: { monthly_report: { information: channels(false, true) } },
  }) } });
  const before = JSON.parse(JSON.stringify(ctx.entreprise.politique_conges));
  const params = JSON.parse(JSON.stringify(ctx.entreprise.parametres));
  const endpoint = `/api/notifications/configuration/${ctx.entreprise.id}`;
  const auth = `Bearer ${generateToken(ctx.admin)}`;
  const saved = await request(app).put(endpoint).set('Authorization', auth)
    .send({ legacy: { [key]: true } }).expect(200);
  expect(saved.body.legacy).toEqual({ ...legacy, [key]: true });
  const loaded = await request(app).get(endpoint).set('Authorization', auth).expect(200);
  expect(loaded.body.legacy).toEqual(saved.body.legacy);
  await ctx.entreprise.reload();
  expect(ctx.entreprise.politique_conges).toEqual({
    ...before, notification_settings: { ...legacy, [key]: true },
  });
  expect(ctx.entreprise.parametres).toEqual(params);
  if (key === 'on_create') {
    const leave = await create();
    expect(leave.statut).toBe('en_attente_manager');
    expect(await Notification.count({ where: { utilisateur_id: ctx.manager.id, type: 'conge_demande' } })).toBe(1);
    await settleEmailWork();
  }
});

test('API : admin isolé, super_admin multi-entreprises, autres rôles interdits', async () => {
  const own = `/api/notifications/configuration/${ctx.entreprise.id}`;
  await request(app).get(own).set('Authorization', `Bearer ${ctx.tokens.admin}`).expect(200);
  await request(app).put(`/api/notifications/configuration/${other.id}`)
    .set('Authorization', `Bearer ${ctx.tokens.admin}`).send({ preferences: config({}) }).expect(403);
  await request(app).get(`/api/notifications/configuration/${other.id}`)
    .set('Authorization', `Bearer ${ctx.tokens.superAdmin}`).expect(200);
  for (const user of [ctx.manager, ctx.employe, apprentice]) {
    await request(app).get(own).set('Authorization', `Bearer ${generateToken(user)}`).expect(403);
  }
  await request(app).put(own).set('Authorization', `Bearer ${ctx.tokens.admin}`)
    .send({ preferences: { ...config({}), admin_scope: { mode: 'users', user_ids: [outsider.id] } } }).expect(400);
});

test.each(['services', 'users'])('distribution %s : deux managers locaux, un admin sélectionné, aucun hors périmètre', async mode => {
  const selected = {
    ...config({
      manager: { leave_created: { action: channels(true, true) } },
      admin_entreprise: { leave_created: { information: channels(true, true) } },
      employe: { leave_created: { information: channels(false, true) } },
    }),
    admin_scope: mode === 'users' ? { mode, user_ids: [admin2.id] } : { mode, services: ['RH'] },
  };
  await preferences.updateConfiguration(ctx.entreprise.id, { preferences: selected }, ctx.admin.id);
  const leave = await create();
  expect(leave.statut).toBe('en_attente_manager');
  await waitForEmails(mode === 'users' ? 3 : 4);
  const recipients = notifications.sendEmailLegacy.mock.calls.map(([payload]) => payload.to);
  expect(recipients).toContain(ctx.manager.email);
  expect(recipients).toContain(manager2.email);
  expect(recipients).not.toContain(outsider.email);
  expect(recipients).not.toContain(ctx.superAdmin.email);
  expect(recipients).not.toContain(ctx.employe.email);
  if (mode === 'users') expect(recipients).not.toContain(ctx.admin.email);
  else expect(recipients).toContain(ctx.admin.email);
  expect(await Notification.count({ where: { utilisateur_id: ctx.employe.id } })).toBe(1);
});

test('apprenti : confirmation propre paramétrable sans accès aux demandes des collègues', async () => {
  await preferences.updateConfiguration(ctx.entreprise.id, { preferences: config({
    apprenti: { leave_created: { information: channels(false, true) } },
  }) }, ctx.admin.id);
  await create(apprentice);
  const alerts = await Notification.findAll({ where: { utilisateur_id: apprentice.id } });
  expect(alerts).toHaveLength(1);
  expect(alerts[0].message).toMatch(/^Pour information/);
});

test('managers nommés : le filtre seul bloque les deux canaux sans ajouter de destinataire hors service', async () => {
  await preferences.updateConfiguration(ctx.entreprise.id, {
    preferences: { ...config({}), manager_scope: { mode: 'users', user_ids: [ctx.manager.id, outsider.id] } },
  }, ctx.admin.id);
  await create();
  await waitForEmails(4);
  const recipients = notifications.sendEmailLegacy.mock.calls.map(([payload]) => payload.to);
  expect(recipients).toContain(ctx.manager.email);
  expect(recipients).not.toContain(manager2.email);
  expect(recipients).not.toContain(outsider.email);
  expect(await Notification.count({ where: { utilisateur_id: manager2.id } })).toBe(0);
  expect(await Notification.count({ where: { utilisateur_id: outsider.id } })).toBe(0);
  expect(await Notification.count({ where: { utilisateur_id: ctx.manager.id } })).toBe(1);
});

test('les identifiants de manager ne peuvent être des admins ou des utilisateurs d’une autre entreprise', async () => {
  const foreign = await Utilisateur.create({
    entreprise_id: other.id, role: 'manager', service: 'RH', statut: 'actif',
    nom: 'Autre manager', email: `foreign-manager.${Date.now()}@test.internal`, password_hash: 'hash',
  });
  for (const id of [ctx.admin.id, foreign.id]) {
    await request(app).put(`/api/notifications/configuration/${ctx.entreprise.id}`)
      .set('Authorization', `Bearer ${ctx.tokens.admin}`)
      .send({ preferences: { ...config({}), manager_scope: { mode: 'users', user_ids: [id] } } }).expect(400);
  }
  await ctx.entreprise.reload();
  expect(ctx.entreprise.parametres?.notifications?.manager_scope).toBeUndefined();
});

test('canaux par service : priorité locale et repli commun, sans changement du workflow ou des destinataires', async () => {
    await apprentice.update({ service: 'Finance' });
    await preferences.updateConfiguration(ctx.entreprise.id, { preferences: {
      ...config({
        manager: { leave_created: { action: channels(true, false) } },
        admin_entreprise: { leave_created: { information: channels(false, false) } },
        employe: { leave_created: { information: channels(true, false) } },
        apprenti: { leave_created: { information: channels(true, false) } },
      }),
      service_roles: { RH: {
        manager: { leave_created: { action: channels(false, true) } },
        employe: { leave_created: { information: channels(false, true) } },
      } },
    } }, ctx.admin.id);
    const rhLeave = await create();
    expect(rhLeave.statut).toBe('en_attente_manager');
    expect(await Notification.count({ where: { utilisateur_id: ctx.employe.id } })).toBe(1);
    expect(await Notification.count({ where: { utilisateur_id: ctx.manager.id } })).toBe(1);
    expect(await Notification.count({ where: { utilisateur_id: outsider.id } })).toBe(0);
    const financeLeave = await create(apprentice);
    expect(financeLeave.statut).toBe('en_attente_manager');
    await waitForEmails(2);
    const recipients = notifications.sendEmailLegacy.mock.calls.map(([payload]) => payload.to);
    expect(recipients).toEqual(expect.arrayContaining([outsider.email, apprentice.email]));
    expect(recipients).not.toContain(ctx.employe.email);
    expect(recipients).not.toContain(ctx.manager.email);
    expect(await Notification.count({ where: { utilisateur_id: apprentice.id } })).toBe(0);
  });

test('les canaux service sont vérifiés par API et le workflow est conservé', async () => {
    const url = `/api/notifications/configuration/${ctx.entreprise.id}`;
    await request(app).put(url).set('Authorization', `Bearer ${ctx.tokens.admin}`)
      .send({ preferences: { ...config({}), service_roles: {
        External: { manager: { leave_created: { action: channels(true, false) } } },
      } } }).expect(400);
    const response = await request(app).get(url).set('Authorization', `Bearer ${ctx.tokens.admin}`).expect(200);
    expect(response.body.default_workflow).toBe('manager_admin');
    expect(response.body.service_workflows).toEqual({ Finance: 'manager_admin', RH: 'manager_admin' });
    await ctx.entreprise.reload();
    expect(ctx.entreprise.parametres?.notifications?.service_roles).toBeUndefined();
});

test('un délégué déjà manager local ne reçoit qu’un email même s’il est aussi destinataire direct', async () => {
  await ctx.manager.update({ delegue_id: manager2.id });
  await preferences.updateConfiguration(ctx.entreprise.id, { preferences: config({
    manager: { leave_created: { action: channels(true, true) } },
  }) }, ctx.admin.id);
  await create();
  await waitForEmails(5);
  expect(notifications.sendEmailLegacy.mock.calls.filter(([payload]) => payload.to === manager2.email)).toHaveLength(1);
  expect(await Notification.count({ where: { utilisateur_id: manager2.id } })).toBe(1);
});

test('idempotence persistante : deux appels concurrents et deux moteurs partagent la même clé', async () => {
  await preferences.updateConfiguration(ctx.entreprise.id, { preferences: config({
    employe: { leave_created: { information: channels(true, true) } },
  }) }, ctx.admin.id);
  const send = jest.fn().mockResolvedValue({ success: true });
  await withContext({ kind: 'leave', employeeId: ctx.employe.id, operationId: 'same-operation' }, async () => {
    await Promise.all([1, 2].map(() => sendConfiguredEmail({
      to: ctx.employe.email, subject: 'Confirmation', templateName: 'leave-created-employee',
    }, send)));
  });
  await withContext({ kind: 'leave', employeeId: ctx.employe.id, operationId: 'same-operation' }, () =>
    sendConfiguredEmail({ to: ctx.employe.email, templateName: 'leave-created-employee' }, send));
  expect(send).toHaveBeenCalledTimes(1);
  expect(await NotificationDelivery.count({ where: { entreprise_id: ctx.entreprise.id } })).toBe(1);
});

test('contenu informatif administratif et confirmation personnelle sont distincts', () => {
  const admin = prepareEmailNotificationMode('Nouvelle demande', 'leave-new-request-manager', {
    notification_mode: 'information', destinataire_role: 'admin_entreprise', commentaire_employe: 'Privé',
  });
  expect(admin.data.message_role).toContain('périmètre administratif');
  expect(admin.data.commentaire_employe).toBe('');
  const owner = prepareEmailNotificationMode('Votre demande', 'leave-created-employee', {
    notification_mode: 'information', notification_owner: true, commentaire_employe: 'Mon motif',
  });
  expect(owner.data.commentaire_employe).toBe('Mon motif');
});

test('l’interrupteur global email reste prioritaire sans marquer un email comme envoyé', async () => {
  await preferences.updateConfiguration(ctx.entreprise.id, { preferences: config({
    employe: { leave_created: { information: channels(true, true) } },
  }) }, ctx.admin.id);
  settings.getSettings.mockResolvedValue({ emailNotifications: false, pushNotifications: false });
  await withContext({ kind: 'leave', employeeId: ctx.employe.id }, () => notifications.sendEmail({
    to: ctx.employe.email, templateName: 'leave-created-employee',
  }));
  expect(notifications.sendEmailLegacy).not.toHaveBeenCalled();
  expect(await NotificationDelivery.count({ where: { entreprise_id: ctx.entreprise.id } })).toBe(0);
});

test.each(['maladie', 'absence_exceptionnelle'])('déclaration %s : information uniquement, propriétaire et managers locaux, périmètre admin respecté', async type => {
  const event = type === 'maladie' ? 'sickness_created' : 'absence_created';
  await preferences.updateConfiguration(ctx.entreprise.id, { preferences: {
    ...config({
      employe: { [event]: { information: channels(false, true) } },
      manager: { [event]: { information: channels(true, true) } },
      admin_entreprise: { [event]: { information: channels(true, true) } },
    }),
    admin_scope: { mode: 'users', user_ids: [admin2.id] },
  } }, ctx.admin.id);
  const absence = await absences.createAbsence({
    utilisateur_id: ctx.employe.id, entreprise_id: ctx.entreprise.id, type_absence: type,
    date_debut: `${year}-08-01`, date_fin: `${year}-08-02`, commentaire: 'Motif privé',
  });
  expect(absence.statut).toBe('signalée');
  const deadline = Date.now() + 5000;
  while (emails.sendEmailLegacy.mock.calls.length < 3 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  expect(emails.sendEmailLegacy.mock.calls.map(([to]) => to).sort())
    .toEqual([manager2.email, ctx.manager.email, admin2.email].sort());
  const notificationDeadline = Date.now() + 5000;
  while (await Notification.count({ where: { entreprise_id: ctx.entreprise.id } }) < 4 && Date.now() < notificationDeadline) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const alerts = await Notification.findAll({ where: { entreprise_id: ctx.entreprise.id } });
  expect(alerts.map(alert => alert.utilisateur_id).sort())
    .toEqual([ctx.employe.id, manager2.id, ctx.manager.id, admin2.id].sort());
  expect(alerts.every(alert => alert.message.startsWith('Pour information'))).toBe(true);
  expect(() => preferences.validatePreferences(config({
    manager: { [event]: { action: channels(true, false) } },
  }), [], [])).toThrow(/uniquement informatifs/);
});

test('un manager inactif ne reçoit rien ; le délégué extérieur au service ne reçoit aucun droit implicite', async () => {
  await manager2.update({ statut: 'inactif' });
  await ctx.manager.update({ delegue_id: outsider.id });
  await preferences.updateConfiguration(ctx.entreprise.id, { preferences: config({
    manager: { leave_created: { action: channels(true, true) } },
  }) }, ctx.admin.id);
  await create();
  await waitForEmails(4);
  const recipients = notifications.sendEmailLegacy.mock.calls.map(([payload]) => payload.to);
  expect(recipients).not.toContain(manager2.email);
  expect(recipients).not.toContain(outsider.email);
});

test('une panne email est journalisée sans annuler la création métier', async () => {
  await preferences.updateConfiguration(ctx.entreprise.id, { preferences: config({
    manager: { leave_created: { action: channels(true, true) } },
  }) }, ctx.admin.id);
  notifications.sendEmailLegacy.mockRejectedValue(new Error('SMTP de test indisponible'));
  const leave = await create();
  expect(leave.statut).toBe('en_attente_manager');
  await waitForEmails(5);
  const deadline = Date.now() + 5000;
  while (await NotificationDelivery.count({ where: { entreprise_id: ctx.entreprise.id, status: 'failed' } }) < 2 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  expect(await NotificationDelivery.count({ where: { entreprise_id: ctx.entreprise.id, status: 'failed' } })).toBe(2);
});

test('le délégué autorisé conserve sa notification persistante lorsque le push est désactivé', async () => {
  await ctx.manager.update({ delegue_id: manager2.id });
  await preferences.updateConfiguration(ctx.entreprise.id, { preferences: config({
    manager: { leave_created: { action: channels(false, true) } },
  }) }, ctx.admin.id);
  await withContext({ kind: 'leave', employeeId: ctx.employe.id }, () => notifications.creerNotification({
    entreprise_id: ctx.entreprise.id, utilisateur_id: ctx.manager.id, type: 'conge_demande',
    notification_mode: 'action', message: 'Demande à traiter',
  }));
  const alerts = await Notification.findAll({ where: { entreprise_id: ctx.entreprise.id } });
  expect(alerts.map(alert => alert.utilisateur_id).sort()).toEqual([ctx.manager.id, manager2.id].sort());
});

test('les rappels en attente activent le canal interne explicite des managers locaux sans doublon journalier', async () => {
  await preferences.updateConfiguration(ctx.entreprise.id, { preferences: config({
    manager: { leave_pending: { action: channels(false, true) } },
  }) }, ctx.admin.id);
  const leave = await create();
  await require('../src/models').sequelize.query('UPDATE conge SET created_at = :created WHERE id = :id', {
    replacements: { created: dayjs().subtract(3, 'day').subtract(1, 'hour').toDate(), id: leave.id },
  });
  const { runPendingLeaveReminders } = require('../src/cron/emailCron');
  await runPendingLeaveReminders();
  await runPendingLeaveReminders();
  const alerts = await Notification.findAll({ where: {
    entreprise_id: ctx.entreprise.id, type: 'conge_rappel_en_attente',
  } });
  for (const manager of [ctx.manager, manager2]) {
    expect(alerts.filter(alert => alert.utilisateur_id === manager.id)).toHaveLength(1);
  }
});

test('une erreur de lecture des préférences ne bloque pas une modification métier d’absence', async () => {
  await preferences.updateConfiguration(ctx.entreprise.id, { preferences: config({
    employe: { absence_created: { information: channels(false, true) } },
  }) }, ctx.admin.id);
  const original = Entreprise.findByPk.bind(Entreprise);
  let failed = false;
  jest.spyOn(Entreprise, 'findByPk').mockImplementation((id, options) => {
    if (!options && !failed) {
      failed = true;
      return Promise.reject(new Error('Lecture configuration indisponible'));
    }
    return original(id, options);
  });
  const absence = await absences.createAbsence({
    utilisateur_id: ctx.employe.id, entreprise_id: ctx.entreprise.id,
    type_absence: 'absence_exceptionnelle', date_debut: `${year}-08-01`, date_fin: `${year}-08-02`,
    commentaire: 'Absence de démonstration',
  });
  expect(absence.statut).toBe('signalée');
});

test('le journal du moteur email conserve le destinataire réel fourni par la configuration', async () => {
  await preferences.updateConfiguration(ctx.entreprise.id, { preferences: config({
    manager: { absence_created: { information: channels(true, true) } },
  }) }, ctx.admin.id);
  emails.sendEmailLegacy.mockRestore();
  const previous = process.env.MAIL_SIMULATE;
  process.env.MAIL_SIMULATE = 'true';
  try {
    await withContext({ kind: 'absence', event: 'absence_created', employeeId: ctx.employe.id },
      () => emails.sendEmail(ctx.manager.email, 'Déclaration fictive', 'absence-notification', {}));
    const log = await require('../src/models').EmailLog.findOne({ where: {
      entreprise_id: ctx.entreprise.id, utilisateur_id: ctx.manager.id,
    } });
    expect(log).not.toBeNull();
    expect(log.to_address).toBe(ctx.manager.email);
    expect(log.statut).toBe('simulated');
  } finally {
    if (previous === undefined) delete process.env.MAIL_SIMULATE;
    else process.env.MAIL_SIMULATE = previous;
  }
});

test('le rappel de réservation déduplique le délégué également manager destinataire direct', async () => {
  await ctx.manager.update({ delegue_id: manager2.id });
  await preferences.updateConfiguration(ctx.entreprise.id, { preferences: config({
    manager: { leave_reservation: { action: channels(false, true) } },
  }) }, ctx.admin.id);
  const leave = await create();
  await Conge.update({
    statut: 'reserve', date_debut: dayjs().add(7, 'day').format('YYYY-MM-DD'),
    date_fin: dayjs().add(8, 'day').format('YYYY-MM-DD'),
  }, { where: { id: leave.id } });
  await require('../src/cron/emailCron').runReservationReminders();
  const alerts = await Notification.findAll({ where: {
    entreprise_id: ctx.entreprise.id, type: 'conge_rappel_reservation',
  } });
  for (const manager of [ctx.manager, manager2]) {
    expect(alerts.filter(alert => alert.utilisateur_id === manager.id)).toHaveLength(1);
  }
});

async function settleEmailWork() {
  let previous = -1;
  let stable = 0;
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 50));
    const count = notifications.sendEmailLegacy.mock.calls.length + emails.sendEmailLegacy.mock.calls.length;
    stable = count === previous ? stable + 1 : 0;
    if (stable >= 15) return;
    previous = count;
  }
  throw new Error('Les emails ne se stabilisent pas.');
}

test.each([
  ['employe', false, true],
  ['employe', true, false],
  ['employe', true, true],
  ['apprenti', false, true],
  ['apprenti', true, false],
])('validation manager : %s, email=%s, application=%s indépendants', async (role, email, inApp) => {
  const owner = role === 'apprenti' ? apprentice : ctx.employe;
  await preferences.updateConfiguration(ctx.entreprise.id, { preferences: {
    ...config({
      [role]: {
        leave_manager_validated: { information: channels(email, inApp) },
        leave_validated: { information: channels(false, false) },
      },
      admin_entreprise: { leave_manager_validated: { action: channels(false, true) } },
    }),
    admin_scope: { mode: 'users', user_ids: [admin2.id] },
  } }, ctx.admin.id);
  const leave = await create(owner);
  await settleEmailWork();
  notifications.sendEmailLegacy.mockClear();
  const decision = await conges.validerConge(leave.id, ctx.manager, 'Validation manager');
  expect(decision.statut).toBe('valide_manager');
  await settleEmailWork();
  const alerts = await Notification.findAll({ where: {
    entreprise_id: ctx.entreprise.id, type: 'conge_valide_manager',
  } });
  expect(alerts.filter(alert => alert.utilisateur_id === owner.id)).toHaveLength(inApp ? 1 : 0);
  expect(alerts.filter(alert => alert.utilisateur_id === admin2.id)).toHaveLength(1);
  expect(alerts.some(alert => [ctx.admin.id, ctx.superAdmin.id, outsider.id].includes(alert.utilisateur_id))).toBe(false);
  const ownEmails = notifications.sendEmailLegacy.mock.calls.map(([payload]) => payload)
    .filter(payload => payload.to === owner.email && payload.templateName === 'leave-manager-validated-employee');
  expect(ownEmails).toHaveLength(email ? 1 : 0);
  if (inApp) expect(alerts.find(alert => alert.utilisateur_id === owner.id).message).toMatch(/^Pour information/);
});

test.each([false, true])('validation manager : historique sans opt-in et interrupteur désactivé (%s) préservés', async disabled => {
  if (disabled) {
    await preferences.updateConfiguration(ctx.entreprise.id, { preferences: config({
      employe: { leave_manager_validated: { information: channels(true, true) } },
    }) }, ctx.admin.id);
    await ctx.entreprise.update({ politique_conges: {
      ...ctx.entreprise.politique_conges, notification_settings: { on_validate: false },
    } });
  }
  const leave = await create();
  await conges.validerConge(leave.id, ctx.manager, 'Validation');
  expect(await Notification.count({ where: {
    utilisateur_id: ctx.employe.id, type: 'conge_valide_manager',
  } })).toBe(0);
  await settleEmailWork();
});

test('Socket : validation manager sans personnalisation conserve le transport historique', async () => {
  const leave = await create();
  const transport = jest.spyOn(sockets, 'notifyUserLegacy').mockReturnValue(true);
  await sockets.notifyUser(ctx.employe.id, 'conge-validated', { conge: { ...leave, statut: 'valide_manager' } });
  expect(transport).toHaveBeenCalledWith(ctx.employe.id, 'conge-validated', expect.any(Object));
  await settleEmailWork();
});

test('Socket : push désactivé bloque le direct sans empêcher la confirmation persistante', async () => {
  await preferences.updateConfiguration(ctx.entreprise.id, { preferences: config({
    employe: { leave_manager_validated: { information: channels(false, true) } },
  }) }, ctx.admin.id);
  const transport = jest.spyOn(sockets, 'notifyUserLegacy').mockReturnValue(true);
  const leave = await create();
  await conges.validerConge(leave.id, ctx.manager, 'Validation');
  transport.mockClear();
  await sockets.notifyUser(ctx.employe.id, 'conge-validated', { conge: { ...leave, statut: 'valide_manager' } });
  expect(transport).not.toHaveBeenCalled();
  expect(await Notification.count({ where: { utilisateur_id: ctx.employe.id, type: 'conge_valide_manager' } })).toBe(1);
  await settleEmailWork();
});

test('Socket : la validation manager ne peut pas être envoyée à une autre entreprise', async () => {
  await preferences.updateConfiguration(ctx.entreprise.id, { preferences: config({
    employe: { leave_manager_validated: { information: channels(false, true) } },
  }) }, ctx.admin.id);
  const external = await Utilisateur.create({
    entreprise_id: other.id, role: 'employe', statut: 'actif', prenom: 'Externe', nom: 'Test',
    email: `external.${other.id}@test.internal`, password_hash: ctx.manager.password_hash,
  });
  const leave = await create();
  const transport = jest.spyOn(sockets, 'notifyUserLegacy').mockReturnValue(true);
  const log = jest.spyOn(require('../src/utils/logger'), 'error');
  await sockets.notifyUser(external.id, 'conge-validated', { conge: { ...leave, statut: 'valide_manager' } });
  expect(transport).not.toHaveBeenCalled();
  expect(log).toHaveBeenCalledWith('notification_preferences_error', expect.objectContaining({ recipientId: external.id }));
  await settleEmailWork();
  await external.destroy();
});

test.each([[false, true], [true, false], [true, true]])(
  'modification en attente : managers locaux email=%s, application=%s sans doublon de délégation',
  async (email, inApp) => {
    await ctx.manager.update({ delegue_id: manager2.id });
    await preferences.updateConfiguration(ctx.entreprise.id, { preferences: {
      ...config({
        manager: { leave_modified: { action: channels(email, inApp) } },
        admin_entreprise: { leave_modified: { information: channels(false, true) } },
      }),
      admin_scope: { mode: 'users', user_ids: [admin2.id] },
    } }, ctx.admin.id);
    const leave = await create();
    await settleEmailWork();
    notifications.sendEmailLegacy.mockClear();
    await conges.updateConge(leave.id, { commentaire_employe: 'Nouvelle demande à traiter' }, ctx.employe);
    expect((await Conge.findByPk(leave.id)).statut).toBe('en_attente_manager');
    await settleEmailWork();
    const alerts = await Notification.findAll({ where: {
      entreprise_id: ctx.entreprise.id, type: 'conge_modifie_employe',
    } });
    const changedEmails = notifications.sendEmailLegacy.mock.calls.map(([payload]) => payload)
      .filter(payload => payload.templateName === 'leave-updated-before-approval');
    for (const manager of [ctx.manager, manager2]) {
      expect(alerts.filter(alert => alert.utilisateur_id === manager.id)).toHaveLength(inApp ? 1 : 0);
      expect(changedEmails.filter(mail => mail.to === manager.email)).toHaveLength(email ? 1 : 0);
    }
    expect(alerts.filter(alert => alert.utilisateur_id === admin2.id)).toHaveLength(1);
    expect(alerts.some(alert => [outsider.id, ctx.superAdmin.id, ctx.admin.id, apprentice.id].includes(alert.utilisateur_id))).toBe(false);
    expect(changedEmails.some(mail => [outsider.email, ctx.superAdmin.email, ctx.admin.email].includes(mail.to))).toBe(false);
  }
);

test('modification en attente : aucun nouveau canal pour les managers locaux sans opt-in', async () => {
  const leave = await create();
  await conges.updateConge(leave.id, { commentaire_employe: 'Modification historique' }, ctx.employe);
  expect(await Notification.count({ where: { utilisateur_id: ctx.manager.id, type: 'conge_modifie_employe' } })).toBe(0);
  await settleEmailWork();
});

test.each([
  ['valide_manager', true, false, true],
  ['valide_manager', false, true, false],
  ['valide_final', true, false, false],
  ['valide_final', false, true, true],
])('Socket : statut=%s, manager=%s, final=%s', async (statut, intermediate, final, expected) => {
  await preferences.updateConfiguration(ctx.entreprise.id, { preferences: config({
    employe: {
      leave_manager_validated: { information: channels(false, intermediate) },
      leave_validated: { information: channels(false, final) },
    },
  }) }, ctx.admin.id);
  settings.getSettings.mockResolvedValue({ emailNotifications: true, pushNotifications: true });
  const transport = jest.spyOn(sockets, 'notifyUserLegacy').mockReturnValue(true);
  const leave = await create();
  transport.mockClear();
  await sockets.notifyUser(ctx.employe.id, 'conge-validated', { conge: { ...leave, statut } });
  expect(transport.mock.calls.filter(([id, event]) => id === ctx.employe.id && event === 'conge-validated'))
    .toHaveLength(expected ? 1 : 0);
  await settleEmailWork();
});

test('routage nommé : manager interservice en action, manager local en information, admin nommé, sans modifier le circuit', async () => {
  await preferences.updateConfiguration(ctx.entreprise.id, { routing: { RH: { conges: {
    [outsider.id]: { mode: 'workflow', email: true, in_app: true },
    [ctx.manager.id]: { mode: 'information', email: true, in_app: true },
    [manager2.id]: { mode: 'none', email: true, in_app: true },
    [ctx.admin.id]: { mode: 'information', email: true, in_app: true },
    [admin2.id]: { mode: 'workflow', email: true, in_app: true },
  } } } }, ctx.admin.id);
  const leave = await create();
  await settleEmailWork();
  const mails = notifications.sendEmailLegacy.mock.calls.map(([payload]) => payload);
  const recipientMail = id => mails.find(mail => mail.data.utilisateur_id === id && mail.templateName === 'leave-new-request-manager');
  expect(recipientMail(outsider.id).data.notification_mode).toBe('action');
  expect(recipientMail(ctx.manager.id).data.notification_mode).toBe('information');
  expect(recipientMail(manager2.id)).toBeUndefined();
  const alerts = await Notification.findAll({ where: { entreprise_id: ctx.entreprise.id, type: 'conge_demande' } });
  expect(alerts.find(item => item.utilisateur_id === outsider.id).message).toMatch(/^Action requise/);
  expect(alerts.find(item => item.utilisateur_id === ctx.manager.id).message).toMatch(/^Pour information/);
  expect(alerts.some(item => item.utilisateur_id === manager2.id)).toBe(false);
  const auth = { Authorization: `Bearer ${generateToken(outsider)}` };
  const detail = await request(app).get(`/api/conges/${leave.id}`).set(auth).expect(200);
  expect(detail.body.manager_can_validate).toBe(true);
  const list = await request(app).get('/api/conges').set(auth).expect(200);
  expect(list.body.items.some(item => item.id === leave.id)).toBe(true);
  const calendar = await request(app).get('/api/calendrier-conges').set(auth).expect(200);
  expect(calendar.body.some(item => item.id === leave.id)).toBe(true);
  const exported = await require('../src/services/exportService').getCongesPreview(ctx.entreprise.id, {}, 50, outsider);
  expect(exported.rows.some(item => item.email === ctx.employe.email)).toBe(true);
  notifications.sendEmailLegacy.mockClear();
  await request(app).post(`/api/conges/${leave.id}/validate`).set(auth).send({}).expect(200);
  await settleEmailWork();
  const next = notifications.sendEmailLegacy.mock.calls.map(([payload]) => payload).filter(mail => mail.templateName === 'leave-manager-approved-admin');
  expect(next.find(mail => mail.to === ctx.admin.email).data.notification_mode).toBe('information');
  expect(next.find(mail => mail.to === admin2.email).data.notification_mode).toBe('action');
  expect((await Conge.findByPk(leave.id)).statut).toBe('valide_manager');
  await ctx.entreprise.reload();
  expect(ctx.entreprise.politique_conges.approval_workflow).toBe('manager_admin');
  expect(ctx.entreprise.parametres?.notifications).toBeUndefined();
});

test('l’information interservice n’autorise pas à lire ou valider, le service inverse et les autres personnes restent inchangés', async () => {
  await preferences.updateConfiguration(ctx.entreprise.id, { routing: { RH: { conges: {
    [outsider.id]: { mode: 'information', email: false, in_app: true },
  } } } }, ctx.admin.id);
  const leave = await create();
  await settleEmailWork();
  const auth = { Authorization: `Bearer ${generateToken(outsider)}` };
  await request(app).get(`/api/conges/${leave.id}`).set(auth).expect(403);
  await request(app).post(`/api/conges/${leave.id}/validate`).set(auth).send({}).expect(403);
  const alert = await Notification.findOne({ where: { utilisateur_id: outsider.id, type: 'conge_demande' } });
  expect(alert.message).toMatch(/^Pour information/);
  const rules = require('../src/services/politiqueConges').getLeaveRules(await Entreprise.findByPk(ctx.entreprise.id));
  const access = require('../src/services/politiqueConges').canManagerAccessService;
  expect(access(ctx.manager, 'Finance', rules, 'validate')).toBe(false);
  expect(access(manager2, 'Finance', rules, 'validate')).toBe(false);
  expect((await Conge.findByPk(leave.id)).statut).toBe('en_attente_manager');
});

test('retirer une autorisation nominative retire seulement ce nouvel accès et ne donne aucun droit sur une autre entreprise', async () => {
  await preferences.updateConfiguration(ctx.entreprise.id, { routing: { RH: { conges: {
    [outsider.id]: { mode: 'workflow', email: true, in_app: true },
  } } } }, ctx.admin.id);
  const leave = await create();
  await settleEmailWork();
  await preferences.updateConfiguration(ctx.entreprise.id, { routing: { RH: { conges: { [outsider.id]: null } } } }, ctx.admin.id);
  await request(app).get(`/api/conges/${leave.id}`).set('Authorization', `Bearer ${generateToken(outsider)}`).expect(403);
  const external = await Utilisateur.create({
    entreprise_id: other.id, role: 'manager', service: 'RH', statut: 'actif', prenom: 'Externe', nom: 'Manager',
    email: `external.named.${Date.now()}@test.internal`, password_hash: ctx.manager.password_hash,
  });
  const api = `/api/notifications/configuration/${ctx.entreprise.id}`;
  const auth = { Authorization: `Bearer ${generateToken(ctx.admin)}` };
  const route = id => ({ routing: { RH: { conges: { [id]: { mode: 'workflow', email: true, in_app: true } } } } });
  await request(app).put(api).set(auth).send(route(external.id)).expect(400);
  await request(app).put(api).set(auth).send(route(ctx.employe.id)).expect(400);
  await manager2.update({ statut: 'inactif' });
  await request(app).put(api).set(auth).send(route(manager2.id)).expect(400);
  await external.destroy();
});

test.each(['absence_exceptionnelle', 'maladie'])('routage %s : suivi interservice nommé sans aucun nouveau droit médical', async category => {
  await preferences.updateConfiguration(ctx.entreprise.id, { routing: { RH: { [category]: {
    [outsider.id]: { mode: 'information', email: true, in_app: true },
    [ctx.admin.id]: { mode: 'none', email: true, in_app: true },
  } } } }, ctx.admin.id);
  const absence = await absences.createAbsence({
    utilisateur_id: ctx.employe.id, entreprise_id: ctx.entreprise.id, type_absence: category,
    date_debut: `${year}-08-01`, date_fin: `${year}-08-02`, commentaire: 'Motif privé interservice',
  });
  await settleEmailWork();
  const mail = emails.sendEmailLegacy.mock.calls.find(([to]) => to === outsider.email);
  expect(mail).toBeDefined();
  expect(mail[3].notification_mode).toBe('information');
  expect(mail[3].commentaire).toBeNull();
  expect(mail[3].content).not.toContain('Motif privé interservice');
  expect(emails.sendEmailLegacy.mock.calls.some(([to]) => to === ctx.admin.email)).toBe(false);
  const response = await request(app).get('/api/absences').set('Authorization', `Bearer ${generateToken(outsider)}`).expect(200);
  expect(response.body.some(item => item.id === absence.id)).toBe(false);
  expect(absence.statut).toBe('signalée');
});

test('la validation du routage refuse les services et modes inconnus sans sauvegarde partielle', async () => {
  const api = `/api/notifications/configuration/${ctx.entreprise.id}`;
  const auth = { Authorization: `Bearer ${generateToken(ctx.admin)}` };
  for (const body of [
    { routing: { External: {} } },
    { routing: { RH: { inconnu: {} } } },
    { routing: { RH: { maladie: { [ctx.manager.id]: { mode: 'workflow', email: true, in_app: true } } } } },
    { routing: { RH: { conges: { [ctx.manager.id]: { mode: 'workflow', email: false, in_app: false } } } } },
    { routing: { RH: { conges: { [ctx.manager.id]: { mode: 'administrator', email: true, in_app: true } } } } },
  ]) await request(app).put(api).set(auth).send(body).expect(400);
  await ctx.entreprise.reload();
  expect(ctx.entreprise.politique_conges.notification_routing).toBeUndefined();
});

test('le push administrateur nommé informatif conserve le même type que son alerte et son email', async () => {
  await preferences.updateConfiguration(ctx.entreprise.id, { routing: { RH: { conges: {
    [ctx.admin.id]: { mode: 'information', email: true, in_app: true },
    [admin2.id]: { mode: 'none', email: false, in_app: false },
  } } } }, ctx.admin.id);
  const leave = await create();
  await settleEmailWork();
  await conges.validerConge(leave.id, ctx.manager);
  await settleEmailWork();
  settings.getSettings.mockResolvedValue({ emailNotifications: true, pushNotifications: true });
  const transport = jest.spyOn(sockets, 'notifyUserLegacy').mockReturnValue(true);
  const io = sockets.io;
  sockets.io = {};
  try {
    await sockets.notifyCompany(ctx.entreprise.id, 'conge-status-changed', {
      action: 'validated', conge: (await Conge.findByPk(leave.id)).toJSON(),
    });
    expect(transport).toHaveBeenCalledWith(ctx.admin.id, 'conge-status-changed', expect.objectContaining({ notification_mode: 'information' }));
    expect(transport.mock.calls.some(([id]) => id === admin2.id)).toBe(false);
  } finally { sockets.io = io; }
});

test('les demandes formelles sont visibles avec l’affectation mais leur circuit figé reste inchangé', async () => {
  await preferences.updateConfiguration(ctx.entreprise.id, { routing: { RH: { conges: {
    [outsider.id]: { mode: 'workflow', email: false, in_app: true },
  } } } }, ctx.admin.id);
  const leave = await create();
  await settleEmailWork();
  await Conge.update({ statut: 'valide_final', effective_approval_workflow: 'admin_only' }, { where: { id: leave.id } });
  const action = await CongeActionRequest.create({
    entreprise_id: ctx.entreprise.id, utilisateur_id: ctx.employe.id, conge_id: leave.id, type: 'cancel',
    commentaire_employe: 'Demande de changement de planning',
  });
  const auth = { Authorization: `Bearer ${generateToken(outsider)}` };
  const detail = await request(app).get(`/api/conges/action-requests/${action.id}`).set(auth).expect(200);
  expect(detail.body.manager_can_validate).toBe(false);
  const list = await request(app).get('/api/conges/action-requests').set(auth).expect(200);
  expect(list.body.requests.some(item => item.id === action.id)).toBe(true);
  await request(app).post(`/api/conges/action-requests/${action.id}/approve`).set(auth).send({}).expect(403);
  expect((await CongeActionRequest.findByPk(action.id)).statut).toBe('pending');
});

test('les patches nominatifs préservent les autres cellules, les règles générales puis le renommage/suppression du service', async () => {
  const route = mode => ({ mode, email: true, in_app: true });
  await preferences.updateConfiguration(ctx.entreprise.id, { routing: { RH: { conges: { [outsider.id]: route('workflow') } } } }, ctx.admin.id);
  await preferences.updateConfiguration(ctx.entreprise.id, { routing: {
    RH: { conges: { [ctx.manager.id]: route('information') }, maladie: { [admin2.id]: route('information') } },
    Finance: { conges: { [manager2.id]: route('workflow') } },
  } }, ctx.admin.id);
  const saved = (await preferences.getConfiguration(ctx.entreprise.id)).routing;
  expect(saved.RH.conges[outsider.id]).toEqual(route('workflow'));
  expect(saved.RH.maladie[admin2.id]).toEqual(route('information'));
  await request(app).put(`/api/entreprises/${ctx.entreprise.id}`).set('Authorization', `Bearer ${generateToken(ctx.superAdmin)}`)
    .send({ politique_conges: { approval_workflow: 'manager_admin' } }).expect(200);
  expect((await preferences.getConfiguration(ctx.entreprise.id)).routing).toEqual(saved);
  const api = `/api/entreprises/${ctx.entreprise.id}/services`;
  const auth = { Authorization: `Bearer ${generateToken(ctx.admin)}` };
  await request(app).put(`${api}/RH`).set(auth).send({ name: 'Support' }).expect(200);
  const renamed = (await preferences.getConfiguration(ctx.entreprise.id)).routing;
  expect(renamed.RH).toBeUndefined();
  expect(renamed.Support).toEqual(saved.RH);
  expect(renamed.Finance).toEqual(saved.Finance);
  await Utilisateur.update({ service: 'Finance' }, { where: { entreprise_id: ctx.entreprise.id, service: 'Support' } });
  await request(app).delete(`${api}/Support`).set(auth).expect(200);
  const removed = (await preferences.getConfiguration(ctx.entreprise.id)).routing;
  expect(removed.Support).toBeUndefined();
  expect(removed.Finance).toEqual(saved.Finance);
});

test('colonne Création : couper demandes et réservations ne coupe pas les validations ni les droits métier', async () => {
  await preferences.updateConfiguration(ctx.entreprise.id, { routing: { RH: { conges: {
    [ctx.manager.id]: { mode: 'workflow', email: true, in_app: true, events: { creation: false } },
    [ctx.admin.id]: { mode: 'workflow', email: true, in_app: true, events: { creation: false } },
  } } } }, ctx.admin.id);
  const leave = await create();
  await settleEmailWork();
  expect(notifications.sendEmailLegacy.mock.calls.some(([mail]) => [ctx.manager.email, ctx.admin.email].includes(mail.to))).toBe(false);
  expect(await Notification.count({ where: { utilisateur_id: ctx.manager.id, type: 'conge_demande' } })).toBe(0);
  await request(app).post(`/api/conges/${leave.id}/validate`).set('Authorization', `Bearer ${generateToken(ctx.manager)}`).send({}).expect(200);
  await settleEmailWork();
  expect(notifications.sendEmailLegacy.mock.calls.some(([mail]) => mail.to === ctx.admin.email && mail.templateName === 'leave-manager-approved-admin')).toBe(true);
  expect((await Conge.findByPk(leave.id)).statut).toBe('valide_manager');
});

test.each(['conges', 'absence_exceptionnelle', 'maladie'])('la case Commentaire %s contrôle nominativement dossiers et emails, sans modifier les données', async category => {
  await preferences.updateConfiguration(ctx.entreprise.id, { routing: { RH: { [category]: {
    [ctx.manager.id]: { mode: 'information', email: true, in_app: true, comments: false },
    [manager2.id]: { mode: 'information', email: true, in_app: true, comments: true },
    [ctx.admin.id]: { mode: 'information', email: true, in_app: true, comments: false },
    [admin2.id]: { mode: 'information', email: true, in_app: true, comments: true },
    [outsider.id]: { mode: 'information', email: true, in_app: true, comments: true },
  } } } }, ctx.admin.id);
  const record = category === 'conges' ? await create() : await absences.createAbsence({
    utilisateur_id: ctx.employe.id, entreprise_id: ctx.entreprise.id, type_absence: category,
    date_debut: `${year}-08-01`, date_fin: `${year}-08-02`, commentaire: 'Commentaire privé',
  });
  await settleEmailWork();
  for (const [reader, allowed] of [[ctx.manager, false], [manager2, true], [ctx.admin, false], [admin2, true]]) {
    const response = await request(app).get(category === 'conges' ? `/api/conges/${record.id}` : '/api/absences')
      .set('Authorization', `Bearer ${generateToken(reader)}`).expect(200);
    const item = category === 'conges' ? response.body : response.body.find(row => row.id === record.id);
    expect(item[category === 'conges' ? 'commentaire_employe' : 'commentaire']).toBe(allowed ? 'Commentaire privé' : null);
    const email = category === 'conges'
      ? notifications.sendEmailLegacy.mock.calls.map(([payload]) => payload).find(mail => mail.to === reader.email)
      : emails.sendEmailLegacy.mock.calls.map(([to, subject, templateName, data]) => ({ to, subject, templateName, data })).find(mail => mail.to === reader.email);
    expect(email).toBeDefined();
    const formatted = prepareEmailNotificationMode(email.subject, email.templateName, email.data);
    expect(formatted.data[category === 'conges' ? 'commentaire_employe' : 'commentaire']).toBe(allowed ? 'Commentaire privé' : '');
    if (category !== 'conges') expect(email.data.content.includes('Commentaire privé')).toBe(allowed);
  }
  const outsiderMail = category === 'conges'
    ? notifications.sendEmailLegacy.mock.calls.map(([payload]) => payload).find(mail => mail.to === outsider.email)
    : emails.sendEmailLegacy.mock.calls.map(([to, subject, templateName, data]) => ({ to, subject, templateName, data })).find(mail => mail.to === outsider.email);
  expect(outsiderMail.data.notification_comments_allowed).toBe(false);
  expect(JSON.stringify(outsiderMail.data)).not.toContain('Commentaire privé');
  const stored = await (category === 'conges' ? Conge : Absence).findByPk(record.id);
  expect(stored[category === 'conges' ? 'commentaire_employe' : 'commentaire']).toBe('Commentaire privé');
});

test('les choix de colonnes invalides sont refusés et une modification partielle conserve les commentaires et catégories existants', async () => {
  const route = { mode: 'workflow', email: true, in_app: true, comments: false, events: { creation: false, suppression: false } };
  await preferences.updateConfiguration(ctx.entreprise.id, { routing: { RH: { conges: { [ctx.manager.id]: route } } } }, ctx.admin.id);
  await preferences.updateConfiguration(ctx.entreprise.id, { routing: { Finance: { conges: {
    [manager2.id]: { mode: 'information', email: true, in_app: false },
  } } } }, ctx.admin.id);
  expect((await preferences.getConfiguration(ctx.entreprise.id)).routing.RH.conges[ctx.manager.id]).toEqual(route);
  for (const extra of [{ events: { inconnu: false } }, { events: { creation: 'false' } }, { comments: 'true' }]) {
    await request(app).put(`/api/notifications/configuration/${ctx.entreprise.id}`)
      .set('Authorization', `Bearer ${generateToken(ctx.admin)}`)
      .send({ routing: { RH: { conges: { [ctx.manager.id]: { ...route, ...extra } } } } }).expect(400);
  }
  expect((await preferences.getConfiguration(ctx.entreprise.id)).routing.RH.conges[ctx.manager.id]).toEqual(route);
});

test('modifier seulement les commentaires ne réactive aucun canal ni destinataire historique désactivé', async () => {
  await preferences.updateConfiguration(ctx.entreprise.id, { preferences: config({
    manager: { leave_created: { workflow: { email: false, in_app: true } } },
  }), routing: { RH: { conges: {
    [ctx.manager.id]: { comments: false }, [outsider.id]: { comments: true, events: { suppression: false } },
  } } } }, ctx.admin.id);
  const leave = await create();
  await settleEmailWork();
  expect(notifications.sendEmailLegacy.mock.calls.some(([mail]) => [ctx.manager.email, outsider.email].includes(mail.to))).toBe(false);
  expect(await Notification.count({ where: { utilisateur_id: outsider.id, type: 'conge_demande' } })).toBe(0);
  expect(await Notification.count({ where: { utilisateur_id: ctx.manager.id, type: 'conge_demande' } })).toBe(1);
  await request(app).get(`/api/conges/${leave.id}`).set('Authorization', `Bearer ${generateToken(outsider)}`).expect(403);
  const detail = await request(app).get(`/api/conges/${leave.id}`).set('Authorization', `Bearer ${generateToken(ctx.manager)}`).expect(200);
  expect(detail.body.commentaire_employe).toBeNull();
  expect(detail.body.manager_can_validate).toBe(true);
});

test('renommer un service conserve les canaux par rôle et les filtres nominatifs historiques des managers', async () => {
  const saved = {
    ...config({}),
    service_roles: { RH: { employe: { leave_created: { workflow: channels(false, true) } } } },
    manager_scope: { mode: 'services', services: ['RH'] },
    manager_event_scopes: { leave_modified: { mode: 'services', services: ['RH'] } },
  };
  await preferences.updateConfiguration(ctx.entreprise.id, { preferences: saved }, ctx.admin.id);
  await request(app).put(`/api/entreprises/${ctx.entreprise.id}/services/RH`)
    .set('Authorization', `Bearer ${generateToken(ctx.admin)}`).send({ name: 'Support' }).expect(200);
  const result = await preferences.getConfiguration(ctx.entreprise.id);
  expect(result.preferences.service_roles.Support).toEqual(saved.service_roles.RH);
  expect(result.preferences.service_roles.RH).toBeUndefined();
  expect(result.preferences.manager_scope.services).toEqual(['Support']);
  expect(result.preferences.manager_event_scopes.leave_modified.services).toEqual(['Support']);
  await preferences.updateConfiguration(ctx.entreprise.id, { preferences: result.preferences }, ctx.admin.id);
});

test('supprimer un service nettoie ses préférences sans élargir les filtres ni bloquer les sauvegardes suivantes', async () => {
  await preferences.updateConfiguration(ctx.entreprise.id, { preferences: {
    ...config({}), service_roles: { RH: { employe: { leave_created: { workflow: channels(false, true) } } } },
    admin_scope: { mode: 'services', services: ['RH'] },
    manager_scope: { mode: 'services', services: ['RH'] },
    manager_event_scopes: { leave_modified: { mode: 'services', services: ['RH', 'Finance'] } },
  } }, ctx.admin.id);
  await Utilisateur.update({ service: 'Finance' }, { where: { entreprise_id: ctx.entreprise.id, service: 'RH' } });
  await request(app).delete(`/api/entreprises/${ctx.entreprise.id}/services/RH`)
    .set('Authorization', `Bearer ${generateToken(ctx.admin)}`).expect(200);
  const result = await preferences.getConfiguration(ctx.entreprise.id);
  expect(result.preferences.service_roles.RH).toBeUndefined();
  expect(result.preferences.admin_scope).toEqual({ mode: 'services', services: [] });
  expect(result.preferences.manager_scope).toEqual({ mode: 'services', services: [] });
  expect(result.preferences.manager_event_scopes.leave_modified.services).toEqual(['Finance']);
  expect(preferences.resolvePreference({
    preferences: result.preferences, recipient: ctx.admin, event: 'leave_created', channel: 'email',
    service: 'Finance', ownerId: ctx.employe.id,
  })).toBe(false);
  expect(preferences.resolvePreference({
    preferences: result.preferences, recipient: ctx.manager, event: 'leave_created', channel: 'in_app',
    service: 'Finance', ownerId: ctx.employe.id,
  })).toBe(false);
  await preferences.updateConfiguration(ctx.entreprise.id, { preferences: result.preferences }, ctx.admin.id);
});

test.each(['auto', 'manager', 'manager_only', 'admin_only', 'manager_admin'])(
  'circuit réel %s : messages adaptés aux étapes et workflow figé malgré un nouveau réglage du service',
  async workflow => {
    const policy = {
      ...ctx.entreprise.politique_conges,
      service_policies: { ...ctx.entreprise.politique_conges.service_policies, RH: { approval_workflow: workflow } },
      notification_routing: { RH: { conges: {
        [ctx.manager.id]: { mode: 'workflow', email: true, in_app: true },
        [admin2.id]: { mode: 'workflow', email: true, in_app: true },
      } } },
    };
    await ctx.entreprise.update({ politique_conges: policy });
    const leave = await create();
    expect(leave.effective_approval_workflow).toBe(workflow);
    expect(leave.statut).toBe(workflow === 'auto' ? 'valide_final' : 'en_attente_manager');
    await settleEmailWork();
    const messages = notifications.sendEmailLegacy.mock.calls.map(([payload]) => payload)
      .filter(payload => payload.templateName === 'leave-new-request-manager');
    for (const [recipient, mode] of [
      [ctx.manager, ['manager', 'manager_only', 'manager_admin'].includes(workflow) ? 'action' : 'information'],
      [admin2, workflow === 'admin_only' ? 'action' : 'information'],
    ]) {
      const received = messages.filter(payload => payload.to === recipient.email);
      expect(received).toHaveLength(1);
      expect(received[0].data).toMatchObject({ notification_mode: mode, destinataire_role: recipient.role });
      expect(await Notification.count({ where: {
        utilisateur_id: recipient.id, type: 'conge_demande',
      } })).toBe(1);
    }
    await ctx.entreprise.update({ politique_conges: {
      ...policy, service_policies: { ...policy.service_policies, RH: { approval_workflow: workflow === 'auto' ? 'manager_admin' : 'auto' } },
    } });
    if (workflow !== 'auto') {
      await conges.validerConge(leave.id, workflow === 'admin_only' ? admin2 : ctx.manager);
      if (workflow === 'manager_admin') {
        expect((await Conge.findByPk(leave.id)).statut).toBe('valide_manager');
        await conges.validerConge(leave.id, admin2);
      }
    }
    const stored = await Conge.findByPk(leave.id);
    expect(stored.statut).toBe('valide_final');
    expect(stored.effective_approval_workflow).toBe(workflow);
    await settleEmailWork();
  },
);
