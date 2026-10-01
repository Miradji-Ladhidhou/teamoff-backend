'use strict';

const bcrypt = require('bcrypt');
const { Entreprise, Utilisateur, CongeType, Conge, CongeActionRequest, CompteurConges, sequelize } = require('../src/models');
const { getConges, getCongeById, validerConge, rejeterConge, deleteConge } = require('../src/services/congesService');
const notificationSocketService = require('../src/services/notificationSocketService');
const congeActionRequestService = require('../src/services/congeActionRequestService');
const emailService = require('../src/services/emailService');
const ExportService = require('../src/services/exportService');
const { getCalendrier } = require('../src/controllers/calendrierController');

const RUN_ID = Date.now();
let entreprise;
let manager;
let managerIT;
let employeeFinance;
let employeeIT;
let congeType;
let congeFinance;
let congeIT;
let managerOwnConge;
let actionRequestIT;
let managerOwnActionRequest;

async function saveServicePermissions(financePermissions, itWorkflow = 'manager_admin', itPermissions = {}) {
  entreprise.politique_conges = {
    approval_workflow: 'manager_admin',
    service_policies: {
      Finance: {
        approval_workflow: 'manager_admin',
        manager_can_view_all_services: financePermissions.manager_can_view_all_services,
        manager_can_validate_all_services: financePermissions.manager_can_validate_all_services,
      },
      IT: {
        approval_workflow: itWorkflow,
        manager_can_view_all_services: itPermissions.manager_can_view_all_services === true,
        manager_can_validate_all_services: itPermissions.manager_can_validate_all_services === true,
      },
    },
  };
  await entreprise.save();
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash('Test1234!', 10);
  entreprise = await Entreprise.create({
    nom: `ManagerScope_${RUN_ID}`,
    politique_conges: {},
    parametres: {},
    statut: 'active',
  });
  [manager, employeeFinance, managerIT, employeeIT] = await Promise.all([
    Utilisateur.create({
      entreprise_id: entreprise.id,
      prenom: 'Manager',
      nom: 'Finance',
      email: `manager.finance.${RUN_ID}@test.internal`,
      role: 'manager',
      statut: 'actif',
      service: 'Finance',
      password_hash: passwordHash,
    }),
    Utilisateur.create({
      entreprise_id: entreprise.id,
      prenom: 'Employee',
      nom: 'Finance',
      email: `employee.finance.${RUN_ID}@test.internal`,
      role: 'employe',
      statut: 'actif',
      service: 'Finance',
      password_hash: passwordHash,
    }),
    Utilisateur.create({
      entreprise_id: entreprise.id,
      prenom: 'Manager',
      nom: 'IT',
      email: `manager.it.${RUN_ID}@test.internal`,
      role: 'manager',
      statut: 'actif',
      service: 'IT',
      password_hash: passwordHash,
    }),
    Utilisateur.create({
      entreprise_id: entreprise.id,
      prenom: 'Employee',
      nom: 'IT',
      email: `employee.it.${RUN_ID}@test.internal`,
      role: 'employe',
      statut: 'actif',
      service: 'IT',
      password_hash: passwordHash,
    }),
  ]);
  congeType = await CongeType.create({
    entreprise_id: entreprise.id,
    code: `MSC${String(RUN_ID).slice(-8)}`,
    libelle: 'Congés scope manager',
    quota_annuel: 25,
    demi_journee_autorisee: true,
  });
  [congeFinance, congeIT] = await Promise.all([
    Conge.create({
      entreprise_id: entreprise.id,
      utilisateur_id: employeeFinance.id,
      conge_type_id: congeType.id,
      date_debut: '2027-03-01',
      date_fin: '2027-03-02',
      statut: 'en_attente_manager',
      effective_approval_workflow: 'manager_admin',
      jours_calcules: 2,
    }),
    Conge.create({
      entreprise_id: entreprise.id,
      utilisateur_id: employeeIT.id,
      conge_type_id: congeType.id,
      date_debut: '2027-04-01',
      date_fin: '2027-04-02',
      statut: 'en_attente_manager',
      effective_approval_workflow: 'manager_admin',
      jours_calcules: 2,
    }),
  ]);
  actionRequestIT = await CongeActionRequest.create({
    conge_id: congeIT.id,
    entreprise_id: entreprise.id,
    utilisateur_id: employeeIT.id,
    type: 'cancel',
    statut: 'pending',
    commentaire_employe: 'Motif privé de test',
    conge_date_debut_origine: congeIT.date_debut,
    conge_date_fin_origine: congeIT.date_fin,
  });
  managerOwnConge = await Conge.create({
    entreprise_id: entreprise.id,
    utilisateur_id: manager.id,
    conge_type_id: congeType.id,
    date_debut: '2027-05-01',
    date_fin: '2027-05-02',
    statut: 'valide_final',
    effective_approval_workflow: 'manager_admin',
    jours_calcules: 2,
  });
  managerOwnActionRequest = await CongeActionRequest.create({
    conge_id: managerOwnConge.id,
    entreprise_id: entreprise.id,
    utilisateur_id: manager.id,
    type: 'cancel',
    statut: 'pending',
    commentaire_employe: 'Demande personnelle',
    conge_date_debut_origine: managerOwnConge.date_debut,
    conge_date_fin_origine: managerOwnConge.date_fin,
  });
  await saveServicePermissions({
    manager_can_view_all_services: false,
    manager_can_validate_all_services: false,
  });
});

afterAll(async () => {
  if (!entreprise) return;
  await sequelize.transaction(async (transaction) => {
    await CongeActionRequest.destroy({ where: { entreprise_id: entreprise.id }, transaction });
    await Conge.destroy({ where: { entreprise_id: entreprise.id }, transaction });
    await CompteurConges.destroy({ where: { entreprise_id: entreprise.id }, transaction });
    await CongeType.destroy({ where: { entreprise_id: entreprise.id }, transaction });
    await Utilisateur.destroy({ where: { entreprise_id: entreprise.id }, transaction });
    await Entreprise.destroy({ where: { id: entreprise.id }, transaction });
  });
});

test('par défaut le manager ne liste ni ne lit le congé d’un autre service', async () => {
  const result = await getConges(manager, { limit: 500 });
  expect(result.items.map((item) => item.id)).toContain(congeFinance.id);
  expect(result.items.map((item) => item.id)).not.toContain(congeIT.id);
  await expect(getCongeById(congeIT.id, manager)).rejects.toThrow(/autres services/);

  const requestResult = await congeActionRequestService.listRequests({ entrepriseId: entreprise.id, user: manager });
  expect(requestResult.requests.map((request) => request.id)).not.toContain(actionRequestIT.id);
  await expect(congeActionRequestService.getRequest(actionRequestIT.id, manager)).rejects.toThrow('Demande introuvable');

  const exportPreview = await ExportService.getCongesPreview(entreprise.id, {}, 50, manager);
  expect(exportPreview.rows.map((row) => row.service)).not.toContain('IT');

  const response = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  await getCalendrier({ params: { year: '2027', month: '4' }, query: {}, user: manager }, response, (error) => { throw error; });
  expect(response.body.map((event) => event.utilisateur?.service)).not.toContain('IT');
});

test('lecture interservices seule expose le congé sans droit de validation', async () => {
  await saveServicePermissions({
    manager_can_view_all_services: true,
    manager_can_validate_all_services: false,
  });

  const result = await getConges(manager, { limit: 500 });
  const item = result.items.find((conge) => conge.id === congeIT.id);
  expect(item).toBeDefined();
  expect(item.manager_can_validate).toBe(false);
  await expect(validerConge(congeIT.id, manager)).rejects.toMatchObject({ statusCode: 403 });

  const requestResult = await congeActionRequestService.listRequests({ entrepriseId: entreprise.id, user: manager });
  expect(requestResult.requests.find((request) => request.id === actionRequestIT.id).toJSON().manager_can_validate).toBe(false);

  const exportPreview = await ExportService.getCongesPreview(entreprise.id, {}, 50, manager);
  expect(exportPreview.rows.map((row) => row.service)).toContain('IT');

  const response = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  await getCalendrier({ params: { year: '2027', month: '4' }, query: {}, user: manager }, response, (error) => { throw error; });
  expect(response.body.map((event) => event.utilisateur?.service)).toContain('IT');
});

test('la validation interservices est active dans l’API quand elle est autorisée', async () => {
  await saveServicePermissions({
    manager_can_view_all_services: true,
    manager_can_validate_all_services: true,
  });

  const result = await getConges(manager, { limit: 500 });
  expect(result.items.find((conge) => conge.id === congeIT.id).manager_can_validate).toBe(true);
  await expect(deleteConge(congeIT.id, manager, { commentaire: 'test' }))
    .rejects.toThrow(/modifier ou supprimer les congés des autres services/);
});

test('un délégué ne contourne pas la portée interservices de son manager', async () => {
  await saveServicePermissions({
    manager_can_view_all_services: false,
    manager_can_validate_all_services: false,
  });
  await manager.update({ delegue_id: employeeFinance.id });

  await expect(validerConge(congeIT.id, employeeFinance, 'Validation déléguée'))
    .rejects.toMatchObject({ statusCode: 403 });
});

test('admin_only reste interdit au manager même avec la portée interservices', async () => {
  await saveServicePermissions({
    manager_can_view_all_services: true,
    manager_can_validate_all_services: true,
  }, 'admin_only');
  await congeIT.update({ effective_approval_workflow: 'admin_only' });

  const result = await getConges(manager, { limit: 500 });
  expect(result.items.find((conge) => conge.id === congeIT.id).manager_can_validate).toBe(false);
  await expect(validerConge(congeIT.id, manager)).rejects.toThrow(/admin_only/);
});

test('un manager ne peut pas traiter sa propre demande de modification ou d’annulation', async () => {
  const result = await congeActionRequestService.listRequests({ entrepriseId: entreprise.id, user: manager });
  expect(result.requests.find((request) => request.id === managerOwnActionRequest.id).toJSON().manager_can_validate).toBe(false);
  await expect(congeActionRequestService.approveRequest(managerOwnActionRequest.id, {
    commentaire: 'Auto-validation interdite',
    adminUser: manager,
  })).rejects.toThrow(/sa propre demande/);
});

test('le refus admin informe seulement les managers autorisés à voir le service', async () => {
  await saveServicePermissions({
    manager_can_view_all_services: false,
    manager_can_validate_all_services: false,
  });
  await congeFinance.update({ statut: 'valide_manager' });
  await CompteurConges.create({
    entreprise_id: entreprise.id,
    utilisateur_id: employeeFinance.id,
    conge_type_id: congeType.id,
    annee: 2027,
    jours_acquis: 25,
    jours_pris: 0,
    jours_reserves: 2,
    jours_annules: 0,
  });

  const sendManagerInfo = jest.spyOn(emailService, 'sendLeaveRejectedManagerInfo').mockResolvedValue(undefined);
  try {
    await rejeterConge(congeFinance.id, {
      id: 'scope-test-super-admin',
      role: 'super_admin',
      entreprise_id: entreprise.id,
    }, 'Refus administratif');

    expect(sendManagerInfo).toHaveBeenCalledTimes(1);
    expect(sendManagerInfo.mock.calls[0][0].id).toBe(manager.id);
  } finally {
    sendManagerInfo.mockRestore();
  }
});

test('le socket informe un manager global lecteur sans lui envoyer les commentaires', async () => {
  await saveServicePermissions(
    { manager_can_view_all_services: false, manager_can_validate_all_services: false },
    'manager_admin',
    { manager_can_view_all_services: true, manager_can_validate_all_services: false }
  );

  const originalIo = notificationSocketService.io;
  const originalConnectedUsers = notificationSocketService.connectedUsers;
  const deliveries = [];
  notificationSocketService.io = {
    to: (socketId) => ({
      emit: (event, payload) => deliveries.push({ socketId, event, payload }),
    }),
  };
  notificationSocketService.connectedUsers = new Map([
    [manager.id, 'socket-finance'],
    [managerIT.id, 'socket-it'],
  ]);

  try {
    await notificationSocketService.notifyCompany(entreprise.id, 'conge-created', {
      conge: {
        id: congeFinance.id,
        entreprise_id: entreprise.id,
        utilisateur_id: employeeFinance.id,
        statut: 'en_attente_manager',
        effective_approval_workflow: 'admin_only',
        commentaire_employe: 'motif privé',
        commentaire_manager: 'note privée',
      },
      user: { id: employeeFinance.id },
    });
  } finally {
    notificationSocketService.io = originalIo;
    notificationSocketService.connectedUsers = originalConnectedUsers;
  }

  const localManagerEvent = deliveries.find((delivery) => delivery.socketId === 'socket-finance');
  const globalReaderEvent = deliveries.find((delivery) => delivery.socketId === 'socket-it');
  expect(localManagerEvent.payload.notification_mode).toBe('information');
  expect(globalReaderEvent.payload.notification_mode).toBe('information');
  expect(globalReaderEvent.payload.conge.commentaire_employe).toBeNull();
  expect(globalReaderEvent.payload.conge.commentaire_manager).toBeNull();
});