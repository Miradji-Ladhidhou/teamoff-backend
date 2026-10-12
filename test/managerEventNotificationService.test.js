'use strict';

const { Entreprise, Utilisateur } = require('../src/models');
const { notifyConfiguredManagerEvent } = require('../src/services/managerEventNotificationService');
const notificationService = require('../src/services/notificationService');
const emailService = require('../src/services/emailService');

afterEach(() => jest.restoreAllMocks());

test.each([
  [true, false], [false, true], [true, true], [false, false],
])('une décision terminée suit email=%s application=%s, sans action ni doublon', async (email, in_app) => {
  jest.spyOn(Entreprise, 'findByPk').mockResolvedValue({
    politique_conges: { service_policies: {
      IT: { manager_cross_service: { conges: { view: true, email, in_app, participation: 'action' } } },
      RH: { manager_can_view_all_services: true },
    } },
  });
  const find = jest.spyOn(Utilisateur, 'findAll').mockResolvedValue([
    { id: 'local', role: 'manager', service: 'Finance', email: 'local@test.internal' },
    { id: 'cross', role: 'manager', service: 'IT', email: 'cross@test.internal' },
    { id: 'legacy', role: 'manager', service: 'RH', email: 'legacy@test.internal' },
  ]);
  const create = jest.spyOn(notificationService, 'creerNotification').mockResolvedValue({});
  const send = jest.spyOn(emailService, 'sendEmail').mockResolvedValue(undefined);
  await notifyConfiguredManagerEvent({
    entrepriseId: 'company', service: 'Finance', category: 'conges',
    type: 'decision', message: 'Congé approuvé', url: '/conges/123',
  });
  expect(find).toHaveBeenCalledWith(expect.objectContaining({
    where: { entreprise_id: 'company', role: 'manager', statut: 'actif' },
  }));
  expect(send).toHaveBeenCalledTimes(email ? 1 : 0);
  expect(create).toHaveBeenCalledTimes(email || in_app ? 1 : 0);
  if (email || in_app) {
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      utilisateur_id: 'cross', delivery: expect.objectContaining({ mode: 'information', email, in_app }),
    }));
  }
  if (email) {
    expect(send).toHaveBeenCalledWith('cross@test.internal', 'Congé approuvé', 'manager-event-information',
      expect.objectContaining({ notification_mode: 'information' }));
  }
});

test('les emails de décision attendent le commit et n’informent pas leur auteur', async () => {
  jest.spyOn(Entreprise, 'findByPk').mockResolvedValue({
    politique_conges: { service_policies: { IT: { manager_cross_service: {
      maladie: { email: true, in_app: true, participation: 'information' },
    } } } },
  });
  jest.spyOn(Utilisateur, 'findAll').mockResolvedValue([
    { id: 'author', service: 'IT', email: 'author@test.internal' },
    { id: 'cross', service: 'IT', email: 'cross@test.internal' },
  ]);
  const create = jest.spyOn(notificationService, 'creerNotification').mockResolvedValue({});
  const send = jest.spyOn(emailService, 'sendEmail').mockResolvedValue(undefined);
  const callbacks = [];
  const transaction = { afterCommit: callback => callbacks.push(callback) };
  await notifyConfiguredManagerEvent({
    entrepriseId: 'company', service: 'Finance', category: 'maladie',
    type: 'decision', message: 'Absence traitée', url: '/absences/equipe',
    excludeUserIds: ['author'], transaction,
  });
  expect(create).toHaveBeenCalledTimes(1);
  expect(create.mock.calls[0][0].transaction).toBe(transaction);
  expect(send).not.toHaveBeenCalled();
  expect(callbacks).toHaveLength(1);
  await callbacks[0]();
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0][0]).toBe('cross@test.internal');
});
