'use strict';

const { Sequelize, Op } = require('sequelize');
const { loadSource } = require('../phase3/loadSource');
const sanitizer = require('../../src/utils/sanitizeLogData');
const safety = require('../../src/services/transactionSafety');

function setup({ tag = 'COMMIT', commitError, releaseError, destroyError, hookError, movementError } = {}) {
  const db = new Sequelize('offline', 'offline', 'offline', { dialect: 'postgres', logging: false });
  const commands = [];
  const connection = { query: jest.fn((sql, ...args) => {
    const command = sql.trim().replace(/;$/, '').toUpperCase();
    commands.push(command);
    args.at(-1)(command === 'COMMIT' ? commitError : null, {
      rows: [], rowCount: null, command: command === 'COMMIT' ? tag : command,
    });
  }) };
  db.connectionManager.getConnection = jest.fn().mockResolvedValue(connection);
  db.connectionManager.releaseConnection = jest.fn(async () => { if (releaseError) throw releaseError; });
  db.connectionManager.destroyConnection = jest.fn(async () => { if (destroyError) throw destroyError; });
  safety.installTransactionSafety(db);
  const original = db.transaction.bind(db);
  let ownTransaction;
  db.transaction = jest.fn(callback => original(async t => {
    ownTransaction = t;
    if (hookError) t.afterCommit(() => { throw hookError; });
    return callback(t);
  }));
  const counter = {
    id: 'counter', entreprise_id: 'company', utilisateur_id: 'employee', conge_type_id: 'type', annee: 2026,
    jours_acquis: 10, jours_pris: 0, jours_reserves: 0, jours_reportes: 0,
    update: jest.fn(async function (values) { Object.assign(this, values); }),
  };
  const models = {
    sequelize: db, CompteurConges: { findOne: jest.fn().mockResolvedValue(counter) },
    Utilisateur: { findOne: jest.fn().mockResolvedValue({}), findByPk: jest.fn().mockResolvedValue({
      id: 'employee', entreprise_id: 'company', email: 'offline@example.invalid',
    }) },
    Entreprise: { findByPk: jest.fn().mockResolvedValue({}) },
    CongeType: { findOne: jest.fn().mockResolvedValue({}), findByPk: jest.fn().mockResolvedValue({ libelle: 'CP' }) },
    Conge: { findAll: jest.fn().mockResolvedValue([]) },
  };
  const logger = { error: jest.fn() };
  const movementCreate = jest.fn(async () => { if (movementError) throw movementError; });
  const movement = loadSource('src/services/mouvementSoldeService.js', {
    '../models': { MouvementSolde: { create: movementCreate } },
    '../utils/logger': logger, '../utils/sanitizeLogData': sanitizer,
  }).exports;
  const audit = jest.fn().mockResolvedValue();
  const auditCreate = jest.fn().mockResolvedValue();
  const realAudit = loadSource('src/services/auditHelper.js', {
    '../models': { AuditLog: { create: auditCreate }, Utilisateur: {}, Conge: {} },
    './auditActions': require('../../src/services/auditActions'), '../utils/logger': logger,
  }).exports;
  const service = loadSource('src/services/quotasService.js', {
    '../models': models, sequelize: { Op }, './politiqueConges': { getLeaveRules: () => ({}) },
    './auditHelper': { auditCounter: { updated: audit } }, '../utils/logger': logger,
    './mouvementSoldeService': movement, './transactionSafety': safety, '../utils/sanitizeLogData': sanitizer,
  }).exports;
  const activate = jest.fn().mockResolvedValue({ activated: [{ id: 'reservation' }], still_pending: [] });
  const send = jest.fn().mockResolvedValue();
  const controller = loadSource('src/controllers/quotasController.js', {
    '../services/quotasService': service, '../services/congesService': { tryActivateReservations: activate },
    '../services/emailService': { sendBalanceAdjusted: send }, '../models': models, sequelize: { Op },
    '../utils/logger': logger, '../utils/sanitizeLogData': sanitizer, '../services/usageService': {},
  }).exports;
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() }, next = jest.fn();
  const input = { entrepriseId: 'company', utilisateurId: 'employee', congeTypeId: 'type', annee: 2026,
    values: { jours_acquis: 20 } };
  const run = () => controller.upsertUserCounter({
    user: { id: 'admin', role: 'admin_entreprise', entreprise_id: 'company' },
    params: { utilisateur_id: 'employee' }, body: { conge_type_id: 'type', annee: 2026, jours_acquis: 20 }, query: {},
  }, res, next);
  return { db, commands, models, counter, movementCreate, logger, audit, service, input,
    activate, send, res, next, run, auditCreate, realAudit, ownTransaction: () => ownTransaction };
}

test('nominal native commit returns the original result without extra warnings or writes', async () => {
  const s = setup();
  const result = await s.service.createOrUpdateCounter(s.input);
  expect(result).toEqual({
    compteur: s.counter,
    before: { jours_acquis: 10, jours_pris: 0, jours_reportes: 0, jours_reserves: 0 },
    after: { jours_acquis: 20, jours_pris: 0, jours_reportes: 0, jours_reserves: 0 },
  });
  expect(s.counter.update).toHaveBeenCalledTimes(1);
  expect(s.movementCreate).toHaveBeenCalledTimes(1);
  expect(s.movementCreate.mock.calls[0][1].transaction).toBe(s.ownTransaction());
  expect(safety.isTransactionCommitted(s.ownTransaction())).toBe(true);
});

test.each(['hook', 'release'])('confirmed commit with %s failure preserves result and continues effects exactly once', async kind => {
  const primary = new Error(`${kind} password=synthetic-secret`);
  const destroy = new Error('secondary destroy failed');
  const s = setup(kind === 'hook' ? { hookError: primary } : { releaseError: primary, destroyError: destroy });
  await s.run();
  await Promise.resolve();
  expect(s.next).not.toHaveBeenCalled();
  expect(s.res.json).toHaveBeenCalledWith(expect.objectContaining({
    item: s.counter, activation: { status: 'completed' },
    reservations_activees: [{ id: 'reservation' }],
    warnings: [expect.objectContaining({ code: 'COUNTER_POST_COMMIT_FAILED' })],
  }));
  expect(s.db.transaction).toHaveBeenCalledTimes(1);
  expect(s.counter.update).toHaveBeenCalledTimes(1);
  expect(s.movementCreate).toHaveBeenCalledTimes(1);
  expect(s.audit).toHaveBeenCalledTimes(1);
  expect(s.activate).toHaveBeenCalledTimes(1);
  expect(s.send).toHaveBeenCalledTimes(1);
  expect(s.commands.filter(command => command === 'COMMIT')).toHaveLength(1);
  expect(s.commands).not.toContain('ROLLBACK');
  expect(primary.message).not.toContain('synthetic-secret');
  expect(s.logger.error).toHaveBeenCalledWith('counter_post_commit_failed', expect.objectContaining({
    error: primary.message,
  }));
  if (kind === 'release') {
    expect(primary.cleanupErrors).toEqual([destroy]);
    expect(s.db.connectionManager.destroyConnection).toHaveBeenCalledTimes(1);
    expect(s.logger.error.mock.calls.find(([name]) => name === 'counter_post_commit_failed')[1]
      .cleanupErrors[0].message).toBe(destroy.message);
  }
});

test('synchronous failure of the quota audit hook is recovered only after its own commit', async () => {
  const s = setup();
  s.audit.mockImplementation(() => { throw new Error('synchronous audit hook failed'); });
  await s.run();
  expect(s.next).not.toHaveBeenCalled();
  expect(s.res.json.mock.calls[0][0].warnings[0].code).toBe('COUNTER_POST_COMMIT_FAILED');
  expect(s.activate).toHaveBeenCalledTimes(1);
  expect(s.audit).toHaveBeenCalledTimes(1);
});

test('asynchronous rejection of the quota audit hook produces a visible warning without blocking later effects', async () => {
  const s = setup();
  s.audit.mockRejectedValue(new Error('asynchronous audit hook failed'));
  await s.run();
  expect(s.next).not.toHaveBeenCalled();
  expect(s.res.json.mock.calls[0][0].warnings[0].code).toBe('COUNTER_POST_COMMIT_FAILED');
  expect(s.activate).toHaveBeenCalledTimes(1);
  expect(s.send).toHaveBeenCalledTimes(1);
  expect(s.audit).toHaveBeenCalledTimes(1);
  expect(s.counter.update).toHaveBeenCalledTimes(1);
});

test('foreign flag after a completed callback cannot recover an unconfirmed transaction result', async () => {
  const s = setup();
  const primary = Object.assign(new Error('foreign postcommit flag'), { transactionCommitted: true });
  const fakeTransaction = { LOCK: { UPDATE: 'UPDATE' }, afterCommit: jest.fn(), finished: 'commit' };
  s.db.transaction.mockImplementation(async callback => {
    await callback(fakeTransaction);
    throw primary;
  });
  await s.run();
  expect(s.next).toHaveBeenCalledWith(primary);
  expect(s.res.json).not.toHaveBeenCalled();
  expect(s.activate).not.toHaveBeenCalled();
  expect(s.send).not.toHaveBeenCalled();
  expect(safety.isTransactionCommitted(fakeTransaction)).toBe(false);
  expect(s.counter.update).toHaveBeenCalledTimes(1);
  expect(s.movementCreate).toHaveBeenCalledTimes(1);
});

test.each([
  ['negative command tag', { tag: 'ROLLBACK' }],
  ['missing command tag', { tag: undefined }],
  ['ambiguous network result', { commitError: new Error('socket disconnected at COMMIT') }],
])('%s never produces success, audit hook, email or activation', async (name, options) => {
  // An absent tag must bypass the setup default.
  const s = setup(name === 'missing command tag' ? { tag: null } : options);
  await s.run();
  expect(s.next).toHaveBeenCalledTimes(1);
  expect(s.res.json).not.toHaveBeenCalled();
  expect(s.send).not.toHaveBeenCalled();
  expect(s.activate).not.toHaveBeenCalled();
  expect(s.audit).not.toHaveBeenCalled();
  expect(safety.isTransactionCommitted(s.ownTransaction())).toBe(false);
  expect(s.counter.update).toHaveBeenCalledTimes(1);
  expect(s.movementCreate).toHaveBeenCalledTimes(1);
  expect(s.db.transaction).toHaveBeenCalledTimes(1);
  expect(s.ownTransaction().finished).toBe('commit');
});

test('foreign committed flag on a body failure does not certify the counter or rerun it', async () => {
  const primary = Object.assign(new Error('movement failed'), { transactionCommitted: true });
  const s = setup({ movementError: primary });
  await s.run();
  expect(s.next).toHaveBeenCalledWith(primary);
  expect(s.res.json).not.toHaveBeenCalled();
  expect(s.activate).not.toHaveBeenCalled();
  expect(s.send).not.toHaveBeenCalled();
  expect(s.commands).toContain('ROLLBACK');
  expect(safety.isTransactionCommitted(s.ownTransaction())).toBe(false);
  expect(s.db.transaction).toHaveBeenCalledTimes(1);
});

test('confirmed counter warning and subsequent activation failure are both retained', async () => {
  const s = setup({ hookError: new Error('first postcommit hook failed') });
  s.activate.mockRejectedValue(new Error('activation failed'));
  await s.run();
  expect(s.res.json).toHaveBeenCalledWith(expect.objectContaining({
    item: s.counter, reservations_activees: null, reservations_en_attente: null,
    warnings: [expect.objectContaining({ code: 'COUNTER_POST_COMMIT_FAILED' })],
    activation: expect.objectContaining({ status: 'failed' }),
  }));
  expect(s.next).not.toHaveBeenCalled();
  expect(s.counter.update).toHaveBeenCalledTimes(1);
});

test('later failing hooks do not lose the first error or secondary diagnostics', async () => {
  const first = new Error('first postcommit hook failed');
  const second = new Error('second postcommit hook failed');
  const s = setup({ hookError: first });
  s.audit.mockImplementation(() => { throw second; });
  await s.run();
  expect(first.afterCommitErrors).toEqual([second]);
  expect(s.logger.error.mock.calls.find(([name]) => name === 'counter_post_commit_failed')[1]
    .afterCommitErrors[0].message).toBe(second.message);
  expect(s.activate).toHaveBeenCalledTimes(1);
  expect(s.audit).toHaveBeenCalledTimes(1);
});

test.each([false, true])('real independent quota audit failure is visible without blocking activation (release=%s)', async releaseFails => {
  const s = setup(releaseFails ? { releaseError: new Error('release failed') } : {});
  const primary = new Error('audit insert failed');
  s.auditCreate.mockRejectedValue(primary);
  s.audit.mockImplementation(s.realAudit.auditCounter.updated);
  await s.run();
  const payload = s.res.json.mock.calls[0][0];
  expect(payload.warnings.map(warning => warning.code)).toEqual(releaseFails
    ? ['COUNTER_AUDIT_FAILED', 'COUNTER_POST_COMMIT_FAILED'] : ['COUNTER_AUDIT_FAILED']);
  expect(s.next).not.toHaveBeenCalled();
  expect(s.auditCreate).toHaveBeenCalledTimes(1);
  expect(s.auditCreate.mock.calls[0]).toHaveLength(1);
  expect(s.counter.update).toHaveBeenCalledTimes(1);
  expect(s.activate).toHaveBeenCalledTimes(1);
  expect(s.send).toHaveBeenCalledTimes(1);
  expect(s.commands).not.toContain('ROLLBACK');
});

test('real quota audit reports recorded status and retains nominal response', async () => {
  const s = setup();
  s.audit.mockImplementation(s.realAudit.auditCounter.updated);
  await s.run();
  expect(s.res.json.mock.calls[0][0].warnings).toBeUndefined();
  expect(s.auditCreate).toHaveBeenCalledTimes(1);
});

test('audit failure warning and activation failure remain distinct', async () => {
  const s = setup();
  s.auditCreate.mockRejectedValue(new Error('audit failed'));
  s.audit.mockImplementation(s.realAudit.auditCounter.updated);
  s.activate.mockRejectedValue(new Error('activation failed'));
  await s.run();
  expect(s.res.json.mock.calls[0][0]).toEqual(expect.objectContaining({
    item: s.counter, activation: expect.objectContaining({ status: 'failed' }),
    warnings: [expect.objectContaining({ code: 'COUNTER_AUDIT_FAILED' })],
  }));
});
