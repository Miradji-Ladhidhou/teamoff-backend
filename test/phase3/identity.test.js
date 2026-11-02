'use strict';

const { loadSource } = require('./loadSource');
const Client = jest.fn(() => { throw new Error('Database connections forbidden'); });
const safety = loadSource('config/migrationSafety.js', {
  fs: {}, path: require('path'), dotenv: {}, pg: { Client },
}).exports;
const target = {
  database: 'isolated_copy', databaseOid: '100', cluster: '123',
  serverAddress: '127.0.0.1/32', serverPort: '5432', role: 'ordinary_test_runner',
};

function connection(identity = { ...target, sessionRole: target.role }) {
  return { query: jest.fn(async sql => sql.trim().startsWith('SELECT')
    ? { rows: [identity] } : { rows: [] }) };
}

test('non-superuser identity is checked with qualified catalog functions and no privilege SQL', async () => {
  const c = connection();
  await expect(safety.verifyConnection(c, target)).resolves.toMatchObject(target);
  expect(Client).not.toHaveBeenCalled();
  const sql = c.query.mock.calls.find(([statement]) => statement.trim().startsWith('SELECT'))[0];
  for (const name of ['current_database', 'pg_control_system', 'inet_server_addr', 'inet_server_port']) {
    expect(sql).toContain(`pg_catalog.${name}()`);
    expect(sql).not.toMatch(new RegExp(`(?<![\\w.])${name}\\(`));
  }
  expect(sql).toContain('FROM pg_catalog.pg_database');
  expect(sql).toContain('session_user');
  expect(c.query.mock.calls.map(([statement]) => statement).join('\n')).not.toMatch(/\b(GRANT|REVOKE|ALTER|CREATE|DROP)\b/i);
});

test.each(['database', 'databaseOid', 'cluster', 'serverAddress', 'serverPort', 'role', 'sessionRole'])(
  'mismatch of %s rejects identity without privilege changes', async field => {
    const c = connection({ ...target, sessionRole: target.role, [field]: 'wrong' });
    await expect(safety.verifyConnection(c, target)).rejects.toThrow(/Identité PostgreSQL refusée/);
    expect(c.query).toHaveBeenLastCalledWith('ROLLBACK');
    expect(Client).not.toHaveBeenCalled();
  }
);

test('cluster SELECT denied is propagated, never replaced by a default identity', async () => {
  const c = connection();
  const error = new Error('cluster SELECT denied');
  c.query.mockImplementation(async sql => {
    if (sql.trim().startsWith('SELECT')) throw error;
    return { rows: [] };
  });
  await expect(safety.verifyConnection(c, target)).rejects.toBe(error);
  expect(c.query).toHaveBeenLastCalledWith('ROLLBACK');
});
