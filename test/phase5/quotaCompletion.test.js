'use strict';

const { loadSource } = require('../phase3/loadSource');
const { Op } = require('sequelize');
const sanitizer = require('../../src/utils/sanitizeLogData');

function setup({ activationError, counterError, emailError, lookupError } = {}) {
  const events = [];
  const user = { id: 'employee', entreprise_id: 'company' };
  const compteur = { id: 'counter', jours_acquis: 20 };
  const activationResult = { activated: [{ id: 'reservation' }], still_pending: [] };
  const activate = jest.fn(async () => {
    events.push('activate');
    if (activationError) throw activationError;
    return activationResult;
  });
  const logger = { error: jest.fn() };
  const send = jest.fn(async () => { if (emailError) throw emailError; });
  const models = {
    Utilisateur: { findByPk: jest.fn().mockResolvedValue(user) },
    CongeType: { findByPk: jest.fn(async () => {
      if (lookupError) throw lookupError;
      return { libelle: 'CP' };
    }) },
  };
  const { upsertUserCounter } = loadSource('src/controllers/quotasController.js', {
    '../services/quotasService': { createOrUpdateCounter: jest.fn(async () => {
      if (counterError) throw counterError;
      events.push('counter persisted');
      return { compteur, before: { jours_acquis: 10 }, after: { jours_acquis: 20 } };
    }) },
    '../services/congesService': { tryActivateReservations: activate },
    '../utils/logger': logger, '../utils/sanitizeLogData': sanitizer,
    '../services/usageService': {}, '../services/emailService': { sendBalanceAdjusted: send },
    '../models': models, sequelize: { Op },
  }).exports;
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() }, next = jest.fn();
  const run = () => upsertUserCounter({
    user: { id: 'admin', role: 'admin_entreprise', entreprise_id: 'company' },
    params: { utilisateur_id: 'employee' }, body: { conge_type_id: 'type', annee: 2026 }, query: {},
  }, res, next);
  return { run, res, next, activate, logger, send, compteur, activationResult, events };
}

test('counter success and activation success retain existing arrays and response fields', async () => {
  const s = setup();
  await s.run();
  expect(s.res.json).toHaveBeenCalledWith({
    message: 'Compteur mis à jour', item: s.compteur,
    reservations_activees: s.activationResult.activated, reservations_en_attente: [],
    activation: { status: 'completed' },
  });
  expect(s.events).toEqual(['counter persisted', 'activate']);
  expect(s.next).not.toHaveBeenCalled();
});

test.each([false, true])('activation failure never implies counter rollback or successful activation (postcommit=%s)', async committed => {
  const s = setup({ activationError: Object.assign(new Error('activation failed'), { transactionCommitted: committed }) });
  await s.run();
  expect(s.res.json).toHaveBeenCalledWith(expect.objectContaining({
    item: s.compteur, reservations_activees: null, reservations_en_attente: null,
    activation: expect.objectContaining({
      status: 'failed', code: 'RESERVATION_ACTIVATION_FAILED', transaction_committed: committed,
    }),
  }));
  expect(s.next).not.toHaveBeenCalled();
  expect(s.logger.error).toHaveBeenCalled();
});

test('persistence rejection has no successful response, email or activation', async () => {
  const error = new Error('counter transaction failed');
  const s = setup({ counterError: error });
  await s.run();
  expect(s.next).toHaveBeenCalledWith(error);
  expect(s.res.json).not.toHaveBeenCalled();
  expect(s.activate).not.toHaveBeenCalled();
  expect(s.send).not.toHaveBeenCalled();
});

test('email preparation failure after persistence is warned and does not prevent activation', async () => {
  const s = setup({ lookupError: new Error('lookup failed') });
  await s.run();
  expect(s.activate).toHaveBeenCalledTimes(1);
  expect(s.res.json.mock.calls[0][0].warnings[0].code).toBe('BALANCE_EMAIL_FAILED');
  expect(s.logger.error).toHaveBeenCalled();
  expect(s.next).not.toHaveBeenCalled();
});

test('asynchronous email failure is logged without blocking or failing the persisted counter', async () => {
  const s = setup({ emailError: new Error('mail failed') });
  await s.run();
  await Promise.resolve();
  expect(s.activate).toHaveBeenCalledTimes(1);
  expect(s.next).not.toHaveBeenCalled();
  expect(s.logger.error).toHaveBeenCalled();
});

test('quota cron logs failed activation group and continues later groups and companies', async () => {
  const logger = { info: jest.fn(), error: jest.fn() };
  const activate = jest.fn().mockRejectedValueOnce(new Error('first activation failed'))
    .mockResolvedValue({ activated: [] });
  const accrue = jest.fn().mockResolvedValue({ applied: 1, skipped: 0, total_added: 2 });
  const cron = loadSource('src/cron/quotasCron.js', {
    'node-cron': { schedule: jest.fn() }, '../utils/logger': logger,
    '../utils/sanitizeLogData': sanitizer,
    '../services/cronTaskGroup': require('../../src/services/cronTaskGroup'),
    '../services/quotasService': { ajouterAcquisitionMensuelle: accrue },
    '../services/congesService': { tryActivateReservations: activate },
    '../models': {
      Entreprise: { findAll: async () => [{ id: 'company1' }, { id: 'company2' }] },
      Conge: { findAll: async () => [
        { utilisateur_id: 'employee1', conge_type_id: 'type', annee_compteur: 2026 },
        { utilisateur_id: 'employee1', conge_type_id: 'type', annee_compteur: 2026 },
        { utilisateur_id: 'employee2', conge_type_id: 'type', annee_compteur: 2026 },
      ] },
    },
  }).exports;
  await cron.runMonthlyAccrual();
  expect(activate).toHaveBeenCalledTimes(4);
  expect(accrue).toHaveBeenCalledTimes(2);
  expect(logger.error).toHaveBeenCalledTimes(1);
});
