'use strict';

const { Sequelize, Op } = require('sequelize');
const { loadSource } = require('../phase3/loadSource');
const safety = require('../../src/services/transactionSafety');
const sanitizer = require('../../src/utils/sanitizeLogData');

const names = [
  'creerJourFerie', 'updateJourFerie', 'supprimerJourFerie', 'importerJoursFeriesNationaux',
  'creerModeleJoursFeries', 'importerModeleJoursFeriesCsv', 'appliquerModeleJoursFeries',
];

function setup(name, mode) {
  const db = new Sequelize('offline', 'offline', 'offline', { dialect: 'postgres', logging: false });
  const commands = [];
  const primary = new Error('synthetic postcommit failure');
  const connection = { query: jest.fn((sql, ...args) => {
    const command = sql.trim().replace(/;$/, '').toUpperCase();
    commands.push(command);
    args.at(-1)(command === 'COMMIT' && mode === 'unknown' ? new Error('connection lost') : null,
      { rows: [], rowCount: null, command: command === 'COMMIT' && mode === 'unconfirmed' ? 'ROLLBACK' : command });
  }) };
  db.connectionManager.getConnection = jest.fn().mockResolvedValue(connection);
  db.connectionManager.releaseConnection = jest.fn(async () => { if (mode === 'release') throw primary; });
  db.connectionManager.destroyConnection = jest.fn().mockResolvedValue();
  safety.installTransactionSafety(db);
  let t;
  const transaction = jest.fn(async () => {
    t = await db.transaction();
    if (mode === 'hook') t.afterCommit(() => { throw primary; });
    return t;
  });
  const write = jest.fn().mockResolvedValue();
  const row = { id: 'holiday', date: '2026-11-01', libelle: 'Test', recurrent: false, update: write, destroy: write };
  const template = { id: 'template', name: 'Test', region: null, source_entreprise_id: null, items: [row] };
  const create = jest.fn().mockResolvedValue(row);
  const models = {
    sequelize: { transaction },
    JoursFeries: {
      create, findOne: jest.fn().mockResolvedValue(name === 'appliquerModeleJoursFeries' ? null : row),
      findAll: jest.fn().mockResolvedValue([]), bulkCreate: write, destroy: write,
    },
    HolidayTemplate: { create: jest.fn().mockResolvedValue(template), findByPk: jest.fn().mockResolvedValue(template) },
    HolidayTemplateItem: { bulkCreate: write },
  };
  const logger = { error: jest.fn() };
  const audit = { created: jest.fn(), updated: jest.fn(), deleted: jest.fn() };
  const controller = loadSource('src/controllers/joursFeriesController.js', {
    '../models': models, sequelize: { Op }, json2csv: {}, '../services/auditHelper': { auditFerie: audit },
    '../services/transactionSafety': safety, '../utils/logger': logger, '../utils/sanitizeLogData': sanitizer,
  }, { fetch: jest.fn(async () => ({ ok: true, json: async () => [row] })) }).exports;
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn(), send: jest.fn(), setHeader: jest.fn() };
  const next = jest.fn();
  const run = () => controller[name]({
    user: { id: 'admin', role: 'admin_entreprise', entreprise_id: 'company' },
    params: { id: 'template', year: 2026 }, query: {},
    body: { date: row.date, name: 'Test', csvContent: 'date,libelle,recurrent,est_travail\n2026-11-01,Test,false,false' },
  }, res, next);
  return { run, res, next, logger, commands, transaction, create, write, models, audit, primary, db, row };
}

test.each(names.flatMap(name => ['success', 'hook', 'release', 'unconfirmed', 'unknown'].map(mode => [name, mode])))(
  '%s preserves nominal result and reports only confirmed postcommit errors (%s)', async (name, mode) => {
    const s = setup(name, mode);
    await s.run();
    const confirmed = ['success', 'hook', 'release'].includes(mode);
    expect(s.transaction).toHaveBeenCalledTimes(1);
    expect(s.commands.filter(command => command === 'COMMIT')).toHaveLength(1);
    expect(s.commands).not.toContain('ROLLBACK');
    if (!confirmed) {
      expect(s.next).toHaveBeenCalledTimes(1);
      expect(s.res.json).not.toHaveBeenCalled();
      expect(s.res.send).not.toHaveBeenCalled();
      expect(s.res.setHeader).not.toHaveBeenCalled();
      return;
    }
    expect(s.next).not.toHaveBeenCalled();
    if (mode === 'success') expect(s.res.setHeader).not.toHaveBeenCalled();
    else {
      expect(s.res.setHeader).toHaveBeenCalledWith('X-TeamOff-Warning', 'HOLIDAY_POST_COMMIT_FAILED');
      expect(s.logger.error).toHaveBeenCalledWith('holiday_post_commit_failed',
        expect.objectContaining({ error: s.primary.message }));
    }
    if (name === 'supprimerJourFerie') {
      expect(s.res.status).toHaveBeenCalledWith(204);
      expect(s.res.send).toHaveBeenCalledWith();
      expect(s.res.json).not.toHaveBeenCalled();
      expect(s.write).toHaveBeenCalledTimes(1);
    } else {
      expect(s.res.json).toHaveBeenCalledTimes(1);
      if (['creerJourFerie', 'creerModeleJoursFeries', 'importerModeleJoursFeriesCsv'].includes(name)) {
        expect(s.res.status).toHaveBeenCalledWith(201);
      }
      if (['creerJourFerie', 'updateJourFerie'].includes(name)) expect(s.res.json).toHaveBeenCalledWith(s.row);
      if (['creerModeleJoursFeries', 'importerModeleJoursFeriesCsv'].includes(name)) {
        expect(s.res.json).toHaveBeenCalledWith(expect.objectContaining({ id: 'template', name: 'Test', itemsCount: expect.any(Number) }));
        expect(s.models.HolidayTemplate.create).toHaveBeenCalledTimes(1);
      }
      if (name === 'appliquerModeleJoursFeries') {
        expect(s.res.json).toHaveBeenCalledWith({ message: 'Modèle appliqué avec succès.', created: 1, updated: 0, total: 1 });
        expect(s.create).toHaveBeenCalledTimes(1);
      }
      if (name === 'importerJoursFeriesNationaux') {
        expect(s.res.json).toHaveBeenCalledWith({
          message: 'Import des jours fériés terminé.', imported: 1, updated_recurrent: 0, skipped: 0, total: 1,
        });
        expect(s.write).toHaveBeenCalledTimes(1);
      }
    }
  }
);

test('foreign commit flag and finished state do not authorize holiday recovery', async () => {
  const s = setup('creerJourFerie', 'success');
  const error = Object.assign(new Error('foreign commit flag'), { transactionCommitted: true });
  const fake = { commit: async () => { throw error; }, finished: 'commit' };
  s.transaction.mockResolvedValue(fake);
  await s.run();
  expect(s.next).toHaveBeenCalledWith(error);
  expect(s.res.json).not.toHaveBeenCalled();
  expect(s.res.setHeader).not.toHaveBeenCalled();
});
