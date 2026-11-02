'use strict';

const { Sequelize, Op } = require('sequelize');
const { loadSource } = require('../phase3/loadSource');
const safety = require('../../src/services/transactionSafety');
const actions = require('../../src/services/auditActions');

function setup({ tag = 'COMMIT', auditError, rollbackError } = {}) {
  const db = new Sequelize('offline', 'offline', 'offline', { dialect: 'postgres', logging: false });
  const ledger = { pending: [], committed: [], discarded: [] };
  const commands = [];
  const discard = () => ledger.discarded.push(...ledger.pending.splice(0));
  const connection = { query: jest.fn((sql, ...args) => {
    const command = sql.trim().replace(/;$/, '').toUpperCase();
    commands.push(command);
    if (command === 'COMMIT' && tag === 'COMMIT') ledger.committed.push(...ledger.pending.splice(0));
    else if (command === 'COMMIT' || command === 'ROLLBACK') discard();
    args.at(-1)(command === 'ROLLBACK' ? rollbackError : null, {
      rows: [], rowCount: null, command: command === 'COMMIT' ? tag : command,
    });
  }) };
  db.connectionManager.getConnection = jest.fn().mockResolvedValue(connection);
  db.connectionManager.releaseConnection = jest.fn().mockResolvedValue();
  db.connectionManager.destroyConnection = jest.fn(async () => discard());
  safety.installTransactionSafety(db);
  let transaction;
  const transactionFactory = jest.fn(async () => {
    transaction = await db.transaction();
    return transaction;
  });
  const user = { id: 'admin', role: 'admin_entreprise', entreprise_id: 'company' };
  const row = {
    id: 'holiday', date: '2026-11-01', libelle: 'Old', recurrent: false, est_travail: false,
    update: jest.fn(async () => { ledger.pending.push({ kind: 'business', action: 'updated' }); }),
    destroy: jest.fn(async () => { ledger.pending.push({ kind: 'business', action: 'deleted' }); }),
  };
  const createAudit = jest.fn(async (values, options) => {
    if (auditError) throw auditError;
    const entry = { kind: 'audit', values };
    if (options?.transaction) {
      expect(options.transaction).toBe(transaction);
      ledger.pending.push(entry);
    } else ledger.committed.push(entry);
  });
  const logger = { error: jest.fn() };
  const audit = loadSource('src/services/auditHelper.js', {
    '../models': { AuditLog: { create: createAudit }, Utilisateur: {}, Conge: {} },
    './auditActions': actions, '../utils/logger': logger,
  }).exports;
  const model = {
    create: jest.fn(async () => { ledger.pending.push({ kind: 'business', action: 'created' }); return row; }),
    findOne: jest.fn().mockResolvedValue(row),
  };
  const controller = loadSource('src/controllers/joursFeriesController.js', {
    '../models': { sequelize: { transaction: transactionFactory }, JoursFeries: model },
    sequelize: { Op }, '../services/auditHelper': audit, '../services/transactionSafety': safety, json2csv: {},
    '../utils/logger': logger, '../utils/sanitizeLogData': require('../../src/utils/sanitizeLogData'),
  }).exports;
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn(), send: jest.fn() }, next = jest.fn();
  const run = name => controller[name]({
    user, body: { date: '2026-11-01', libelle: 'New' }, params: { id: 'holiday' }, query: {},
    ip: 'offline', get: () => 'unit-test',
  }, res, next);
  return { db, ledger, commands, createAudit, logger, audit, row, user, model, res, next, run,
    transaction: () => transaction };
}

test.each([
  ['creerJourFerie', actions.FERIE_CREATED],
  ['updateJourFerie', actions.FERIE_UPDATED],
  ['supprimerJourFerie', actions.FERIE_DELETED],
])('%s commits its business operation and actual AuditLog.create with the same transaction', async (name, action) => {
  const s = setup();
  await s.run(name);
  expect(s.next).not.toHaveBeenCalled();
  expect(s.createAudit).toHaveBeenCalledTimes(1);
  expect(s.createAudit).toHaveBeenCalledWith({
    action, entity: 'ferie', entity_id: 'holiday', user_id: 'admin', entreprise_id: 'company',
    ip_address: 'offline', user_agent: 'unit-test', metadata: {},
  }, { transaction: s.transaction() });
  expect(s.ledger.pending).toEqual([]);
  expect(s.ledger.committed.map(row => row.kind)).toEqual(['business', 'audit']);
  expect(safety.isTransactionCommitted(s.transaction())).toBe(true);
});

test.each(['creerJourFerie', 'updateJourFerie', 'supprimerJourFerie'])(
  '%s propagates audit write failure and discards its pending business operation', async name => {
    const primary = new Error('audit write failed');
    const s = setup({ auditError: primary });
    await s.run(name);
    expect(s.next).toHaveBeenCalledWith(primary);
    expect(s.createAudit.mock.calls[0][1].transaction).toBe(s.transaction());
    expect(s.ledger.committed).toEqual([]);
    expect(s.ledger.pending).toEqual([]);
    expect(s.ledger.discarded).toHaveLength(1);
    expect(s.commands.filter(command => command === 'ROLLBACK')).toHaveLength(1);
    expect(s.commands).not.toContain('COMMIT');
    expect(s.res.json).not.toHaveBeenCalled();
    expect(s.res.send).not.toHaveBeenCalled();
  }
);

test.each(['creerJourFerie', 'updateJourFerie', 'supprimerJourFerie'])(
  '%s keeps neither business change nor audit on a COMMIT tagged ROLLBACK in the simulated ledger', async name => {
    const s = setup({ tag: 'ROLLBACK' });
    await s.run(name);
    expect(s.next.mock.calls[0][0].message).toMatch(/non confirmé/);
    expect(s.ledger.committed).toEqual([]);
    expect(s.ledger.pending).toEqual([]);
    expect(s.ledger.discarded.map(row => row.kind)).toEqual(['business', 'audit']);
    expect(s.commands.filter(command => command === 'ROLLBACK')).toHaveLength(0);
    expect(s.res.json).not.toHaveBeenCalled();
    expect(s.res.send).not.toHaveBeenCalled();
  }
);

test('audit write error remains primary if the native rollback also fails', async () => {
  const primary = new Error('audit write failed');
  const secondary = new Error('rollback failed');
  const s = setup({ auditError: primary, rollbackError: secondary });
  await s.run('creerJourFerie');
  expect(s.next).toHaveBeenCalledWith(primary);
  expect(primary.cleanupErrors[0].message).toContain(secondary.message);
  expect(s.db.connectionManager.destroyConnection).toHaveBeenCalledTimes(1);
  expect(s.ledger.committed).toEqual([]);
  expect(s.commands.filter(command => command === 'ROLLBACK')).toHaveLength(1);
});

test('a business error after a successful audit stages then discards both without committing', async () => {
  const primary = new Error('business failed after audit');
  const s = setup();
  const t = await s.db.transaction();
  // This independent helper call shares the real root transaction.
  const create = jest.fn(async (values, options) => {
    expect(options.transaction).toBe(t);
    s.ledger.pending.push({ kind: 'audit', values });
  });
  const { auditFerie } = loadSource('src/services/auditHelper.js', {
    '../models': { AuditLog: { create }, Utilisateur: {}, Conge: {} },
    './auditActions': actions, '../utils/logger': s.logger,
  }).exports;
  s.ledger.pending.push({ kind: 'business' });
  await auditFerie.created(s.row, s.user, {}, { transaction: t });
  await safety.rollbackAfterError(t, primary);
  expect(s.ledger.committed).toEqual([]);
  expect(s.ledger.discarded.map(row => row.kind)).toEqual(['business', 'audit']);
});

test.each(['created', 'updated', 'deleted'])('nontransactional holiday %s keeps its historical one-argument create and nonblocking errors', async name => {
  const s = setup({ auditError: new Error('independent audit failed') });
  await expect(s.audit.auditFerie[name](s.row, s.user, {})).resolves.toBeUndefined();
  expect(s.createAudit.mock.calls[0]).toHaveLength(1);
  expect(s.logger.error).toHaveBeenCalled();
  expect(s.commands).toEqual([]);
});

test('authentication audit remains independent, nonblocking, with unchanged event metadata', async () => {
  const s = setup({ auditError: new Error('auth audit failed') });
  await expect(s.audit.auditAuth.loginSuccess(s.user, {})).resolves.toBeUndefined();
  expect(s.createAudit).toHaveBeenCalledWith(expect.objectContaining({
    action: actions.LOGIN_SUCCESS, entity: 'auth', metadata: {},
  }));
  expect(s.createAudit.mock.calls[0]).toHaveLength(1);
  expect(s.commands).toEqual([]);
});

test('optional transaction reaches auditEntity fallback lookups and actual insertion', async () => {
  const transaction = { offline: true };
  const find = jest.fn().mockResolvedValue({ entreprise_id: 'company' });
  const create = jest.fn().mockResolvedValue();
  const { auditEntity } = loadSource('src/services/auditHelper.js', {
    '../models': { AuditLog: { create }, Utilisateur: { findByPk: find }, Conge: {} },
    './auditActions': actions, '../utils/logger': { error: jest.fn() },
  }).exports;
  await auditEntity({ entity: 'user', entityId: 'employee', action: 'USER_UPDATED',
    performedBy: { role: 'super_admin' }, transaction });
  expect(find).toHaveBeenCalledWith('employee', { attributes: ['entreprise_id'], transaction });
  expect(create.mock.calls[0][1]).toEqual({ transaction });
});

test('transactional fallback failure propagates before any audit write', async () => {
  const primary = new Error('lookup failed');
  const create = jest.fn();
  const { auditEntity } = loadSource('src/services/auditHelper.js', {
    '../models': { AuditLog: { create }, Utilisateur: { findByPk: async () => { throw primary; } }, Conge: {} },
    './auditActions': actions, '../utils/logger': { error: jest.fn() },
  }).exports;
  await expect(auditEntity({ entity: 'user', entityId: 'employee', action: 'USER_UPDATED',
    transaction: { offline: true } })).rejects.toBe(primary);
  expect(create).not.toHaveBeenCalled();
});

test.each(['created', 'updated', 'deleted'])('holiday %s audit uses resource company for super admin without changing metadata', async method => {
  const s = setup();
  const t = await s.db.transaction();
  const create = jest.fn().mockResolvedValue();
  const { auditFerie } = loadSource('src/services/auditHelper.js', {
    '../models': { AuditLog: { create }, Utilisateur: {}, Conge: {} },
    './auditActions': actions, '../utils/logger': s.logger,
  }).exports;
  await auditFerie[method]({ ...s.row, entreprise_id: 'target-company' },
    { id: 'super', role: 'super_admin', entreprise_id: null }, {}, { transaction: t });
  expect(create).toHaveBeenCalledWith(expect.objectContaining({
    entreprise_id: 'target-company', metadata: {},
  }), { transaction: t });
  await t.commit();
});

test('resource company wins over actor company without changing other audit helpers', async () => {
  const s = setup();
  await s.audit.auditFerie.created({ ...s.row, entreprise_id: 'resource-company' }, s.user, {});
  expect(s.createAudit.mock.calls[0][0].entreprise_id).toBe('resource-company');
  await s.audit.auditAuth.loginSuccess(s.user, {});
  expect(s.createAudit.mock.calls[1][0].entreprise_id).toBe('company');
});

test('only quota audit opts into an explicit nonblocking result', async () => {
  const primary = new Error('audit failed');
  const s = setup({ auditError: primary });
  await expect(s.audit.auditCounter.updated(s.row, {}, {}, s.user, {}))
    .resolves.toEqual({ status: 'failed', error: primary });
  await expect(s.audit.auditAuth.loginSuccess(s.user, {})).resolves.toBeUndefined();
  const success = setup();
  await expect(success.audit.auditCounter.updated(success.row, {}, {}, success.user, {}))
    .resolves.toEqual({ status: 'recorded' });
});
