'use strict';

const { loadSource } = require('../phase3/loadSource');
const { Transaction } = require('sequelize');
const entrepriseId = '11111111-1111-4111-8111-111111111111';

function setup({ existing = null, fail = null, commitFail = null, rollbackFail = null, emailFail = null } = {}) {
  const events = [];
  const t = { LOCK: { UPDATE: 'UPDATE' } };
  t.commit = async () => {
    if (t.finished) throw new Error('Transaction already finished');
    t.finished = 'commit';
    events.push('commit');
    if (commitFail) throw commitFail;
  };
  t.rollback = async () => {
    if (t.finished) throw new Error('Transaction already finished');
    t.finished = 'rollback';
    events.push('rollback');
    if (rollbackFail) throw rollbackFail;
  };
  const user = { id: 'user', email: 'user@example.invalid', entreprise_id: entrepriseId };
  const counter = { jours_acquis: '12', jours_reserves: '3', update: jest.fn() };
  const getImportCounter = jest.fn().mockResolvedValue(counter);
  const movementCreate = jest.fn(async () => {
    events.push('movement');
    if (fail) throw fail;
  });
  const sanitizer = require('../../src/utils/sanitizeLogData');
  const { logMouvement: realMovement } = loadSource('src/services/mouvementSoldeService.js', {
    '../models': { MouvementSolde: { create: movementCreate } },
    '../utils/logger': { error: jest.fn() }, '../utils/sanitizeLogData': sanitizer,
  }).exports;
  const logMouvement = jest.fn(realMovement);
  const send = jest.fn().mockImplementation(async () => {
    events.push('email');
    if (emailFail) throw emailFail;
  });
  const auditImport = {
    usersSuccess: jest.fn().mockResolvedValue(), usersFailed: jest.fn().mockResolvedValue(),
  };
  const sequelize = { transaction: jest.fn(async (options, callback) => {
    events.push('begin');
    let result;
    try {
      result = await callback(t);
    } catch (error) {
      try { await t.rollback(); } catch (cleanupError) { error.cleanupErrors = [cleanupError]; }
      throw error;
    }
    await t.commit();
    return result;
  }) };
  const deps = {
    crypto: require('crypto'), jsonwebtoken: { sign: jest.fn(() => 'fake-invitation') },
    bcrypt: { hash: jest.fn().mockResolvedValue('fake-hash') },
    'csv-parse/sync': require('csv-parse/sync'), sequelize: { Transaction },
    '../models': {
      sequelize, Entreprise: { findByPk: jest.fn().mockResolvedValue({ id: entrepriseId }) },
      CongeType: { findAll: jest.fn().mockResolvedValue([{ id: 'type', libelle: 'CP' }]) },
      Utilisateur: { findOne: jest.fn().mockResolvedValue(existing), create: jest.fn().mockResolvedValue(user) },
    },
    '../services/importCounterService': { getImportCounter },
    '../services/importUserService': {
      getImportUser: jest.fn().mockResolvedValue({ user: existing || user, created: !existing }),
    },
    '../utils/sanitizeLogData': sanitizer,
    '../services/transactionSafety': require('../../src/services/transactionSafety'),
    '../services/emailService': { sendSetPasswordEmail: send },
    '../services/quotasService': { initializeUserCounters: jest.fn().mockResolvedValue() },
    '../services/auditHelper': { auditImport },
    '../utils/logger': { error: jest.fn() },
    '../utils/csvDecoder': { decodeCsvBuffer: buffer => buffer.toString() },
    '../services/mouvementSoldeService': { logMouvement },
    'iconv-lite': {},
  };
  const { importUsersCSV } = loadSource('src/controllers/usersImportController.js', deps).exports;
  const req = {
    body: { entreprise_id: entrepriseId }, user: { id: 'admin' },
    file: { buffer: Buffer.from('nom,prenom,email,CP (N),CP (N-1)\nNom,Prenom,user@example.invalid,25,5') },
  };
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  const next = jest.fn();
  return { run: () => importUsersCSV(req, res, next), req, res, next, events, sequelize,
    getImportCounter, counter, logMouvement, movementCreate, send, auditImport, t };
}

test('import preserves balances, movement, response and post-commit invitation with explicit READ COMMITTED', async () => {
  const s = setup();
  await s.run();
  expect(s.sequelize.transaction.mock.calls[0][0]).toEqual({ isolationLevel: 'READ COMMITTED' });
  expect(s.getImportCounter).toHaveBeenCalledWith({
    entreprise_id: entrepriseId, utilisateur_id: 'user', conge_type_id: 'type',
    annee: new Date().getFullYear(),
  }, s.t);
  expect(s.counter.update).toHaveBeenCalledWith({ jours_acquis: 30, jours_reportes: 5 }, { transaction: s.t });
  expect(s.logMouvement).toHaveBeenCalledWith(expect.objectContaining({
    quantite: 18, solde_apres: 27, transaction: s.t,
  }));
  expect(s.events).toEqual(['begin', 'movement', 'commit', 'email']);
  expect(s.movementCreate).toHaveBeenCalledTimes(1);
  expect(s.res.status).toHaveBeenCalledWith(201);
  expect(s.res.json).toHaveBeenCalledWith(expect.objectContaining({
    message: '1 employé(s) créé(s), 0 ignoré(s), 1 solde(s) mis à jour',
  }));
  expect(s.next).not.toHaveBeenCalled();
});

test('existing employee keeps the skipped reason and receives no new invitation', async () => {
  const s = setup({ existing: { id: 'user', email: 'user@example.invalid', entreprise_id: entrepriseId } });
  await s.run();
  expect(s.res.status).toHaveBeenCalledWith(200);
  expect(s.res.json.mock.calls[0][0].skipped[0].reason).toBe('email déjà utilisé (soldes mis à jour)');
  expect(s.send).not.toHaveBeenCalled();
});

test('another company is skipped without changing its counter', async () => {
  const s = setup({ existing: { entreprise_id: 'another-company' } });
  await s.run();
  expect(s.getImportCounter).not.toHaveBeenCalled();
  expect(s.res.json.mock.calls[0][0].skipped[0].reason).toBe('appartient à une autre entreprise');
});

test('duplicate CSV email is rejected before starting a transaction', async () => {
  const s = setup();
  s.req.file.buffer = Buffer.from('nom,prenom,email\nA,B,user@example.invalid\nC,D,user@example.invalid');
  await s.run();
  expect(s.res.status).toHaveBeenCalledWith(422);
  expect(s.sequelize.transaction).not.toHaveBeenCalled();
});

test('counter failure rolls back, reports the original error and never sends an invitation', async () => {
  const s = setup();
  const error = new Error('counter conflict');
  s.getImportCounter.mockRejectedValue(error);
  await s.run();
  expect(s.next).toHaveBeenCalledWith(error);
  expect(s.events).toEqual(['begin', 'rollback']);
  expect(s.send).not.toHaveBeenCalled();
  expect(s.auditImport.usersSuccess).not.toHaveBeenCalled();
  expect(s.auditImport.usersFailed).toHaveBeenCalled();
  expect(s.res.json).not.toHaveBeenCalled();
});

test('later movement failure rolls back the whole import, not only the counter', async () => {
  const error = new Error('movement write failed');
  const s = setup({ fail: error });
  await s.run();
  expect(s.next).toHaveBeenCalledWith(error);
  expect(s.events).toEqual(['begin', 'movement', 'rollback']);
  expect(s.send).not.toHaveBeenCalled();
});

test('commit rejection has no HTTP success, invitation or success audit', async () => {
  const error = new Error('commit failed');
  const s = setup({ commitFail: error });
  await s.run();
  expect(s.next).toHaveBeenCalledWith(error);
  expect(s.res.json).not.toHaveBeenCalled();
  expect(s.send).not.toHaveBeenCalled();
  expect(s.auditImport.usersSuccess).not.toHaveBeenCalled();
  expect(s.events).not.toContain('rollback');
});

test('a post-commit flag from an unrelated operation cannot certify the import transaction', async () => {
  const error = Object.assign(new Error('unrelated commit flag'), { transactionCommitted: true });
  const s = setup({ fail: error });
  await s.run();
  expect(s.next).toHaveBeenCalledWith(error);
  expect(s.res.json).not.toHaveBeenCalled();
  expect(s.send).not.toHaveBeenCalled();
  expect(s.events).toContain('rollback');
});

test.each(['release', 'hook'])('confirmed native COMMIT with %s failure still sends invitations and audits persisted import', async failure => {
  const s = setup();
  const { Sequelize } = require('sequelize');
  const { installTransactionSafety } = require('../../src/services/transactionSafety');
  const db = new Sequelize('offline', 'offline', 'offline', { dialect: 'postgres', logging: false });
  const commands = [];
  const connection = { query: jest.fn((sql, ...args) => {
    const command = sql.trim().replace(/;$/, '').toUpperCase();
    commands.push(command);
    args.at(-1)(null, { rows: [], rowCount: null, command });
  }) };
  db.connectionManager.getConnection = jest.fn().mockResolvedValue(connection);
  db.connectionManager.releaseConnection = jest.fn(async () => {
    if (failure === 'release') throw new Error('release failed');
  });
  db.connectionManager.destroyConnection = jest.fn().mockResolvedValue();
  installTransactionSafety(db);
  s.sequelize.transaction.mockImplementation((options, callback) => db.transaction(options, async t => {
    if (failure === 'hook') t.afterCommit(() => { throw new Error('hook failed'); });
    return callback(t);
  }));
  await s.run();
  await Promise.resolve();
  expect(commands).toContain('COMMIT');
  expect(commands).not.toContain('ROLLBACK');
  expect(s.res.status).toHaveBeenCalledWith(201);
  expect(s.res.json.mock.calls[0][0].warnings).toEqual([
    expect.objectContaining({ code: 'IMPORT_POST_COMMIT_FAILED' }),
  ]);
  expect(s.send).toHaveBeenCalledTimes(1);
  expect(s.auditImport.usersSuccess).toHaveBeenCalledTimes(1);
  expect(s.auditImport.usersFailed).not.toHaveBeenCalled();
  expect(s.next).not.toHaveBeenCalled();
});

test('real movement SQL error survives rollback failure and has no success effects', async () => {
  const error = new Error('movement SQL failed');
  const secondary = new Error('rollback failed');
  const s = setup({ fail: error, rollbackFail: secondary });
  await s.run();
  expect(s.next).toHaveBeenCalledWith(error);
  expect(error.cleanupErrors).toEqual([secondary]);
  expect(s.send).not.toHaveBeenCalled();
  expect(s.auditImport.usersSuccess).not.toHaveBeenCalled();
  expect(s.movementCreate).toHaveBeenCalledTimes(1);
});

test('synchronous invitation and audit exceptions after commit are logged, not transaction failures', async () => {
  const s = setup();
  s.send.mockImplementation(() => { throw new Error('synchronous SMTP'); });
  s.auditImport.usersSuccess.mockImplementation(() => { throw new Error('synchronous audit'); });
  await s.run();
  await Promise.resolve();
  expect(s.res.status).toHaveBeenCalledWith(201);
  expect(s.next).not.toHaveBeenCalled();
  expect(s.events).toEqual(['begin', 'movement', 'commit']);
});

test.each([new Error('SMTP password=private-value'), new Error('synchronous transport failure')])(
  'post-commit transport failure does not roll back or hide HTTP success', async emailFail => {
    const s = setup({ emailFail });
    await s.run();
    await Promise.resolve();
    expect(s.events).toEqual(['begin', 'movement', 'commit', 'email']);
    expect(s.next).not.toHaveBeenCalled();
    expect(s.res.status).toHaveBeenCalledWith(201);
    expect(s.send).toHaveBeenCalledTimes(1);
  }
);
