'use strict';

const { loadSource } = require('../phase3/loadSource');
const { Sequelize, Op } = require('sequelize');
const safety = require('../../src/services/transactionSafety');

function response() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn(), send: jest.fn() };
}

function holidays(transaction, model = {}) {
  return loadSource('src/controllers/joursFeriesController.js', {
    '../models': { sequelize: { transaction: async () => transaction }, JoursFeries: model,
      HolidayTemplate: { findByPk: async () => null }, HolidayTemplateItem: {} },
    sequelize: { Op }, '../services/auditHelper': { auditFerie: { created: jest.fn() } },
    json2csv: {}, '../services/transactionSafety': safety,
    '../utils/logger': { error: jest.fn() },
    '../utils/sanitizeLogData': require('../../src/utils/sanitizeLogData'),
  }).exports;
}

test.each([
  'creerJourFerie', 'updateJourFerie', 'supprimerJourFerie', 'importerJoursFeriesNationaux',
  'creerModeleJoursFeries', 'importerModeleJoursFeriesCsv', 'appliquerModeleJoursFeries',
])('%s preserves failed early rollback without requesting it a second time', async name => {
  const error = new Error('rollback cleanup failed');
  const transaction = { rollback: jest.fn(async () => {
    transaction.finished = 'rollback';
    throw error;
  }) };
  const controller = holidays(transaction);
  const res = response(), next = jest.fn();
  await controller[name]({ user: { role: 'super_admin' }, body: {}, params: {}, query: {} }, res, next);
  expect(next).toHaveBeenCalledWith(error);
  expect(transaction.rollback).toHaveBeenCalledTimes(1);
  expect(res.json).not.toHaveBeenCalled();
});

test.each([
  ['ROLLBACK', 'Error'], ['COMMIT', 'Error'], ['COMMIT', 'SequelizeUniqueConstraintError'],
])('real holiday controller with native transaction preserves %s / %s error', async (tag, errorName) => {
  const db = new Sequelize('offline', 'offline', 'offline', { dialect: 'postgres', logging: false });
  const connection = { query: jest.fn((sql, ...args) => {
    const command = sql.trim().replace(/;$/, '').toUpperCase();
    args.at(-1)(null, { rows: [], rowCount: null, command: command === 'COMMIT' ? tag : command });
  }) };
  db.connectionManager.getConnection = jest.fn().mockResolvedValue(connection);
  db.connectionManager.releaseConnection = jest.fn().mockResolvedValue();
  db.connectionManager.destroyConnection = jest.fn().mockResolvedValue();
  safety.installTransactionSafety(db);
  const t = await db.transaction();
  const created = { id: 'holiday' };
  const controller = holidays(t, { create: jest.fn().mockResolvedValue(created) });
  const res = response(), next = jest.fn();
  const responseError = new Error('response failed');
  responseError.name = errorName;
  if (tag === 'COMMIT') res.json.mockImplementation(() => { throw responseError; });
  await controller.creerJourFerie({
    user: { role: 'admin_entreprise', entreprise_id: 'company' }, body: { date: '2026-11-01' },
  }, res, next);
  const observed = next.mock.calls[0][0];
  if (tag === 'COMMIT') expect(observed).toBe(responseError);
  else expect(observed.message).toMatch(/non confirmé/);
  expect(res.status).not.toHaveBeenCalledWith(409);
  expect(connection.query.mock.calls.filter(([sql]) => sql.trim() === 'ROLLBACK;')).toHaveLength(0);
});

test('holiday uniqueness conflict before commit retains the existing HTTP409 response', async () => {
  const error = Object.assign(new Error('duplicate holiday'), { name: 'SequelizeUniqueConstraintError' });
  const transaction = { rollback: jest.fn(async () => { transaction.finished = 'rollback'; }) };
  const controller = holidays(transaction, { create: jest.fn().mockRejectedValue(error) });
  const res = response(), next = jest.fn();
  await controller.creerJourFerie({
    user: { role: 'admin_entreprise', entreprise_id: 'company' }, body: { date: '2026-11-01' },
  }, res, next);
  expect(res.status).toHaveBeenCalledWith(409);
  expect(transaction.rollback).toHaveBeenCalledTimes(1);
  expect(next).not.toHaveBeenCalled();
});

test.each(['body', 'commit', 'postcommit'])('service rename preserves %s error instead of a failed rollback', async scenario => {
  const error = new Error(`${scenario} failed`);
  const rollbackError = new Error('rollback failed');
  const transaction = {
    commit: jest.fn(async () => {
      transaction.finished = 'commit';
      if (scenario === 'commit') throw error;
    }),
    rollback: jest.fn(async () => { transaction.finished = 'rollback'; throw rollbackError; }),
  };
  const company = {
    id: 'company', politique_conges: { service_policies: { RH: {} } },
    save: jest.fn(async () => { if (scenario === 'body') throw error; }),
  };
  const crossService = require('../../src/services/managerCrossServicePolicy');
  const { updateEntrepriseService } = loadSource('src/controllers/entreprisesController.js', {
    bcrypt: {}, crypto: {}, jsonwebtoken: {}, sequelize: { Op },
    '../models': { Entreprise: { findByPk: async () => company },
      Utilisateur: { count: async () => 0 }, sequelize: { transaction: async () => transaction } },
    '../utils/logger': { error: jest.fn() }, 'express-validator': {},
    '../services/auditHelper': { auditEntreprise: { updated: async () => {
      if (scenario === 'postcommit') throw error;
    } } },
    '../services/emailService': {}, '../services/quotasService': {},
    '../services/authService': {}, '../services/congesService': {},
    '../services/mouvementSoldeService': {}, '../services/transactionSafety': safety,
    '../services/managerCrossServicePolicy': crossService,
    '../services/notificationPreferencesService': {},
  }).exports;
  const res = response(), next = jest.fn();
  await updateEntrepriseService({
    user: { id: 'admin' }, params: { id: 'company', serviceName: 'RH' }, body: {},
  }, res, next);
  expect(next).toHaveBeenCalledWith(error);
  expect(transaction.rollback).toHaveBeenCalledTimes(scenario === 'body' ? 1 : 0);
  if (scenario === 'body') expect(error.cleanupErrors).toEqual([rollbackError]);
  expect(res.json).not.toHaveBeenCalled();
});
