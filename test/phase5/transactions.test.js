'use strict';

const { Sequelize } = require('sequelize');
const { installTransactionSafety, rollbackAfterError } = require('../../src/services/transactionSafety');

function setup({ commitTag = 'COMMIT', commitError, rollbackError, destroyError } = {}) {
  const events = [];
  const sequelize = new Sequelize('offline', 'offline', 'offline', { dialect: 'postgres', logging: false });
  const connection = {
    query: jest.fn((sql, ...args) => {
      const callback = args.at(-1);
      const command = sql.trim().replace(/;$/, '').toUpperCase();
      events.push(command);
      if (command === 'COMMIT' && commitError) return callback(commitError);
      if (command === 'ROLLBACK' && rollbackError) return callback(rollbackError);
      callback(null, { rows: [], rowCount: null, command: command === 'COMMIT' ? commitTag : command });
    }),
  };
  sequelize.connectionManager.getConnection = jest.fn().mockResolvedValue(connection);
  sequelize.connectionManager.releaseConnection = jest.fn().mockResolvedValue();
  sequelize.connectionManager.destroyConnection = jest.fn(async () => {
    events.push('destroy');
    if (destroyError) throw destroyError;
  });
  installTransactionSafety(sequelize);
  return { sequelize, connection, events };
}

test('real installed Sequelize transaction and PG Query confirm commit before hooks, once', async () => {
  const s = setup();
  installTransactionSafety(s.sequelize);
  const hook = jest.fn(() => s.events.push('success'));
  expect(await s.sequelize.transaction(async t => {
    t.afterCommit(hook);
    s.events.push('body');
    return 42;
  })).toBe(42);
  expect(s.events.slice(-3)).toEqual(['body', 'COMMIT', 'success']);
  expect(hook).toHaveBeenCalledTimes(1);
  expect(s.sequelize.connectionManager.releaseConnection).toHaveBeenCalledTimes(1);
  expect(s.sequelize.connectionManager.destroyConnection).not.toHaveBeenCalled();
});

test.each(['ROLLBACK', undefined, 'unexpected'])(
  'simulated driver COMMIT tag %s is rejected without afterCommit success', async commitTag => {
    const s = setup({ commitTag });
    // Default parameter supplies COMMIT for undefined; remove it explicitly.
    if (commitTag === undefined) s.connection.query.mockImplementation((sql, ...args) =>
      args.at(-1)(null, { rows: [], rowCount: null }));
    const hook = jest.fn();
    await expect(s.sequelize.transaction(async t => { t.afterCommit(hook); })).rejects.toThrow(/non confirmé/);
    expect(hook).not.toHaveBeenCalled();
    expect(s.sequelize.connectionManager.destroyConnection).toHaveBeenCalledTimes(1);
  }
);

test('body failure rolls back, never commits and preserves the exact error', async () => {
  const s = setup();
  const error = new Error('validation failed');
  const hook = jest.fn();
  await expect(s.sequelize.transaction(async t => {
    t.afterCommit(hook);
    throw error;
  })).rejects.toBe(error);
  expect(s.events.at(-1)).toBe('ROLLBACK');
  expect(s.events).not.toContain('COMMIT');
  expect(hook).not.toHaveBeenCalled();
});

test('rollback SQL plus cleanup failure are secondary to the body failure', async () => {
  const s = setup({
    rollbackError: new Error('rollback failed'), destroyError: new Error('destroy failed'),
  });
  const error = new Error('movement failed');
  await expect(s.sequelize.transaction(async () => { throw error; })).rejects.toBe(error);
  expect(error.cleanupErrors).toHaveLength(1);
  expect(error.cleanupErrors[0].message).toMatch(/rollback failed/);
  expect(error.cleanupErrors[0].cleanupErrors[0].message).toBe('destroy failed');
  expect(s.sequelize.connectionManager.destroyConnection).toHaveBeenCalledTimes(1);
});

test('commit SQL error survives native forceCleanup rejection and does not run hooks', async () => {
  const s = setup({ commitError: new Error('password=do-not-log commit'), destroyError: new Error('cleanup failed') });
  const hook = jest.fn();
  let error;
  try { await s.sequelize.transaction(async t => t.afterCommit(hook)); } catch (e) { error = e; }
  expect(error.name).toBe('SequelizeDatabaseError');
  expect(error.message).toContain('commit');
  expect(error.message).not.toContain('do-not-log');
  expect(error.cleanupErrors[0].message).toBe('cleanup failed');
  expect(hook).not.toHaveBeenCalled();
  expect(s.events).not.toContain('ROLLBACK');
});

test.each(['commit', 'rollback'])('an already %s transaction cannot be finished again', async method => {
  const s = setup();
  const t = await s.sequelize.transaction();
  await t[method]();
  const queries = s.connection.query.mock.calls.length;
  await expect(t.commit()).rejects.toThrow(/finished/);
  await expect(t.rollback()).rejects.toThrow(/finished/);
  expect(s.connection.query).toHaveBeenCalledTimes(queries);
});

test('a failing afterCommit hook is explicitly a post-commit error, not rollback', async () => {
  const s = setup();
  const error = new Error('transport failed');
  await expect(s.sequelize.transaction(async t => {
    t.afterCommit(() => { throw error; });
  })).rejects.toBe(error);
  expect(error.transactionCommitted).toBe(true);
  expect(s.events).toContain('COMMIT');
  expect(s.events).not.toContain('ROLLBACK');
});

test('all post-commit hooks run in order before their errors are reported', async () => {
  const s = setup();
  const first = new Error('first hook failed');
  const second = new Error('second hook failed');
  const events = [];
  await expect(s.sequelize.transaction(async t => {
    t.afterCommit(async function (transaction) {
      expect(this).toBe(t);
      expect(transaction).toBe(t);
      events.push('first');
      throw first;
    });
    t.afterCommit(() => { events.push('second'); throw second; });
    t.afterCommit(async () => { events.push('third'); });
  })).rejects.toBe(first);
  expect(events).toEqual(['first', 'second', 'third']);
  expect(first.afterCommitErrors).toEqual([second]);
  expect(first.transactionCommitted).toBe(true);
  expect(s.events).not.toContain('ROLLBACK');
  expect(s.sequelize.connectionManager.releaseConnection).toHaveBeenCalledTimes(1);
});

test('the next hook waits for a pending asynchronous hook even when it ultimately rejects', async () => {
  const s = setup();
  const error = new Error('async hook failed');
  let rejectHook, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const pending = new Promise((resolve, reject) => { rejectHook = reject; });
  const next = jest.fn();
  const run = s.sequelize.transaction(async t => {
    t.afterCommit(() => { entered(); return pending; });
    t.afterCommit(next);
  });
  const rejection = expect(run).rejects.toBe(error);
  await ready;
  expect(next).not.toHaveBeenCalled();
  rejectHook(error);
  await rejection;
  expect(next).toHaveBeenCalledTimes(1);
});

test('hook errors remain primary when release and destruction also fail', async () => {
  const destroy = new Error('destroy failed');
  const s = setup({ destroyError: destroy });
  const release = new Error('release failed');
  s.sequelize.connectionManager.releaseConnection.mockRejectedValue(release);
  const hookError = new Error('hook failed');
  const later = jest.fn();
  await expect(s.sequelize.transaction(async t => {
    t.afterCommit(() => { throw hookError; });
    t.afterCommit(later);
  })).rejects.toBe(hookError);
  expect(later).toHaveBeenCalledTimes(1);
  expect(hookError.cleanupErrors).toEqual([release]);
  expect(release.cleanupErrors).toEqual([destroy]);
  expect(hookError.transactionCommitted).toBe(true);
});

test('manual rollback preserves the body error and does not repeat cleanup after failure', async () => {
  const s = setup({ rollbackError: new Error('rollback failed'), destroyError: new Error('destroy failed') });
  const t = await s.sequelize.transaction();
  const primary = new Error('body failed');
  await rollbackAfterError(t, primary);
  expect(primary.cleanupErrors[0].message).toContain('rollback failed');
  expect(primary.cleanupErrors[0].cleanupErrors[0].message).toBe('destroy failed');
  const calls = s.connection.query.mock.calls.length;
  await rollbackAfterError(t, primary);
  expect(s.connection.query).toHaveBeenCalledTimes(calls);
  expect(primary.cleanupErrors).toHaveLength(1);
});

test.each([true, false])('manual catch never rolls back a finished commit (confirmed=%s)', async confirmed => {
  const s = setup({ commitTag: confirmed ? 'COMMIT' : 'ROLLBACK' });
  const t = await s.sequelize.transaction();
  let primary = new Error('HTTP response failed after commit');
  try { await t.commit(); } catch (error) { primary = error; }
  const calls = s.connection.query.mock.calls.length;
  await rollbackAfterError(t, primary);
  expect(s.connection.query).toHaveBeenCalledTimes(calls);
  expect(s.events).not.toContain('ROLLBACK');
});

test('failed child hooks do not prevent other child or parent hooks after outer commit', async () => {
  const s = setup();
  const error = new Error('child effect failed');
  const events = [];
  await expect(s.sequelize.transaction(async parent => {
    await s.sequelize.transaction({ transaction: parent }, async child => {
      child.afterCommit(() => { events.push('child1'); throw error; });
      child.afterCommit(() => events.push('child2'));
    });
    parent.afterCommit(() => events.push('parent'));
    expect(events).toEqual([]);
  })).rejects.toBe(error);
  expect(events).toEqual(['child1', 'child2', 'parent']);
  expect(error.transactionCommitted).toBe(true);
});

test('savepoints still use native Sequelize and outer commit owns the hooks', async () => {
  const s = setup();
  await s.sequelize.transaction(async parent => {
    await s.sequelize.transaction({ transaction: parent }, async child => {
      expect(child.parent).toBe(parent);
    });
  });
  expect(s.events.filter(sql => sql === 'COMMIT')).toHaveLength(1);
  expect(s.sequelize.connectionManager.getConnection).toHaveBeenCalledTimes(1);
});

test('child afterCommit is forwarded only after outer commit, never after outer rollback', async () => {
  for (const fail of [false, true]) {
    const s = setup();
    const hook = jest.fn();
    const run = s.sequelize.transaction(async parent => {
      await s.sequelize.transaction({ transaction: parent }, async child => child.afterCommit(hook));
      expect(hook).not.toHaveBeenCalled();
      if (fail) throw new Error('outer failed');
    });
    if (fail) await expect(run).rejects.toThrow(/outer failed/);
    else await run;
    expect(hook).toHaveBeenCalledTimes(fail ? 0 : 1);
  }
});

test.each([true, false])('pool release rejection with commit=%s is explicit and is never retried', async commit => {
  for (const variant of ['async', 'sync', 'destroy failure']) {
    const destroyError = variant === 'destroy failure' ? new Error('destroy failed') : undefined;
    const s = setup({ destroyError });
    const release = new Error('release failed');
    if (variant === 'sync') {
      s.sequelize.connectionManager.releaseConnection.mockImplementation(() => { throw release; });
    } else s.sequelize.connectionManager.releaseConnection.mockRejectedValue(release);
    const body = new Error('body failed');
    const run = s.sequelize.transaction(async () => { if (!commit) throw body; });
    await expect(run).rejects.toBe(commit ? release : body);
    if (commit) expect(release.transactionCommitted).toBe(true);
    else expect(body.cleanupErrors).toEqual([release]);
    if (destroyError) expect(release.cleanupErrors).toEqual([destroyError]);
    expect(s.sequelize.connectionManager.releaseConnection).toHaveBeenCalledTimes(1);
    expect(s.sequelize.connectionManager.destroyConnection).toHaveBeenCalledTimes(1);
  }
});
