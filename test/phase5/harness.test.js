'use strict';

const harness = require('../../config/integrationHarness');
const { loadSource } = require('../phase3/loadSource');
const url = 'postgres://teamoff_phase4_app:simulation@127.0.0.1:5432/teamoff_phase4_isolated_20261101';
const env = () => ({
  NODE_ENV: 'test', TEAMOFF_INTEGRATION_HARNESS: 'isolated', TEAMOFF_HARNESS_DATABASE_URL: url,
});
const objects = () => [
  ...harness.tables.map(name => ({ kind: 'relation', schema: 'public', name, owner: harness.target.databaseOwner, subtype: 'r' })),
  ...harness.enums.map(name => ({ kind: 'type', schema: 'public', name, owner: harness.target.databaseOwner, subtype: 'e' })),
  ...harness.tables.map(name => ({
    kind: 'type', schema: 'public', name, owner: harness.target.databaseOwner, subtype: 'c', parent: name,
  })),
  ...[...harness.tables, ...harness.enums].map(parent => ({
    kind: 'type', schema: 'public', name: `_${parent}`, owner: harness.target.databaseOwner, subtype: 'b', parent,
  })),
  ...Object.entries(harness.uuidFunctions).map(([name, args]) => ({
    kind: 'function', schema: 'public', name, owner: 'utilisateur', subtype: 'f',
    arguments: args, extension: 'uuid-ossp', securityDefiner: false,
  })),
  { kind: 'schema', schema: 'public', name: 'public', owner: 'pg_database_owner' },
  { kind: 'extension', schema: 'public', name: 'uuid-ossp', owner: harness.target.databaseOwner, version: '1.1' },
  { kind: 'extension', schema: 'pg_catalog', name: 'plpgsql', owner: 'utilisateur', version: '1.0' },
];
const identity = () => ({
  ...harness.target, sessionRole: harness.target.role,
  rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false,
  rolbypassrls: false, membership: false, databaseCreate: false, schemaCreate: false,
  temporary: false, ownership: false,
  objects: objects(),
});
const connection = () => ({
  query: jest.fn().mockResolvedValue({ rows: [identity()] }), end: jest.fn().mockResolvedValue(),
});

test('dedicated URL is required, with no implicit historical fallback', () => {
  expect(harness.loadHarnessConfig(env()).url).toBe(url);
  expect(() => harness.loadHarnessConfig({
    NODE_ENV: 'test', TEAMOFF_INTEGRATION_HARNESS: 'isolated', DATABASE_URL: url,
  })).toThrow(/URL PostgreSQL/);
});

test.each(['teamoff', 'teamoff_notifications_test', 'postgres', 'another_copy'])(
  'refuses database %s before any connection', database => {
    expect(() => harness.loadHarnessConfig({
      ...env(), TEAMOFF_HARNESS_DATABASE_URL: url.replace(harness.target.database, database),
    })).toThrow(/Cible du harness refusée/);
  }
);

test.each([
  ['host', '127.0.0.1', 'localhost'], ['host', '127.0.0.1', 'remote.invalid'],
  ['port', '5432', '5433'], ['role', 'teamoff_phase4_app', 'postgres'],
  ['role', 'teamoff_phase4_app', 'teamoff_phase4_owner'],
  ['role', 'teamoff_phase4_app', 'teamoff_phase4_migrator'],
  ['role', 'teamoff_phase4_app', 'teamoff_phase4_test_runner'],
  ['role', 'teamoff_phase4_app', 'teamoff_phase4_backup'],
])('rejects wrong %s (%s -> %s)', (_, old, replacement) => {
  expect(() => harness.loadHarnessConfig({
    ...env(), TEAMOFF_HARNESS_DATABASE_URL: url.replace(old, replacement),
  })).toThrow(/Cible du harness refusée/);
});

test.each([
  { NODE_ENV: 'production' }, { TEAMOFF_INTEGRATION_HARNESS: 'yes' },
  { DATABASE_URL: 'postgres://historical@127.0.0.1/teamoff' },
  { DATABASE_TEST_URL: 'postgres://historical@127.0.0.1/teamoff' },
  { DATABASE_TEST_NAME: 'teamoff' }, { PGUSER: 'postgres' },
  { PGHOST: 'remote.invalid' }, { NODE_OPTIONS: '--require dangerous.js' },
  { DOTENV_CONFIG_PATH: '/historical/.env' },
])('inherited contradiction or substitution is rejected: %j', change => {
  expect(() => harness.loadHarnessConfig({ ...env(), ...change })).toThrow();
});

test('identity validation is one catalog-qualified SELECT with no transaction or DDL', async () => {
  const c = connection();
  expect(await harness.verifyConnection(c, 'models')).toEqual(identity());
  expect(c.query).toHaveBeenCalledTimes(1);
  const sql = c.query.mock.calls[0][0];
  expect(sql.trim()).toMatch(/^SELECT/);
  expect(sql).toContain('pg_catalog.pg_control_system()');
  expect(sql).not.toMatch(/\b(ALTER|DROP|GRANT|REVOKE|BEGIN|COMMIT|ROLLBACK)\b/);
});

test.each([
  ...Object.keys(harness.target).filter(key => key !== 'host'), 'sessionRole',
  'rolsuper', 'rolcreatedb', 'rolcreaterole', 'rolreplication', 'rolbypassrls',
  'membership', 'databaseCreate', 'temporary', 'schemaCreate', 'ownership',
])('rejects unexpected identity or authority field %s', async field => {
  const c = connection();
  const actual = identity();
  actual[field] = typeof actual[field] === 'boolean' ? true : 'unexpected';
  c.query.mockResolvedValue({ rows: [actual] });
  await expect(harness.verifyConnection(c, 'queries')).rejects.toThrow(/pool queries/);
});

test('identity read failure closes a rejected physical connection without masking cleanup failure', async () => {
  const pool = { addHook: jest.fn() };
  harness.protectPool(pool, 'models');
  const hook = pool.addHook.mock.calls[0][1];
  const c = connection();
  const primary = new Error('catalog read failed');
  const secondary = new Error('close failed');
  c.query.mockRejectedValue(primary);
  c.end.mockRejectedValue(secondary);
  await expect(hook(c)).rejects.toBe(primary);
  expect(primary.cleanupError).toBe(secondary);
  expect(c.end).toHaveBeenCalledTimes(1);
});

test('every physical connection is verified, not only the first connection of a pool', async () => {
  const pool = { addHook: jest.fn() };
  harness.protectPool(pool, 'queries');
  const hook = pool.addHook.mock.calls[0][1];
  const first = connection();
  const second = connection();
  second.query.mockResolvedValue({ rows: [{ ...identity(), databaseOid: '16384' }] });
  await hook(first);
  await expect(hook(second)).rejects.toThrow(/pool queries/);
  expect(first.query).toHaveBeenCalledTimes(1);
  expect(second.end).toHaveBeenCalledTimes(1);
});

function pool(c = connection()) {
  const value = {
    addHook: jest.fn(),
    connectionManager: {
      getConnection: jest.fn().mockResolvedValue(c), releaseConnection: jest.fn().mockResolvedValue(),
    }, close: jest.fn().mockResolvedValue(),
  };
  harness.protectPool(value, 'simulation');
  return value;
}

test('the two pools are verified and released independently', async () => {
  const models = pool();
  const queries = pool();
  expect(await harness.verifyPools({ models, queries })).toEqual({
    models: identity(), queries: identity(),
  });
  expect(models.connectionManager.releaseConnection).toHaveBeenCalledTimes(1);
  expect(queries.connectionManager.releaseConnection).toHaveBeenCalledTimes(1);
});

test('a second-pool mismatch cannot pass on the strength of the first pool', async () => {
  const models = pool();
  const c = connection();
  c.query.mockResolvedValue({ rows: [{ ...identity(), cluster: 'wrong-cluster' }] });
  const queries = pool(c);
  await expect(harness.verifyPools({ models, queries })).rejects.toThrow(/pool queries/);
  expect(queries.connectionManager.releaseConnection).toHaveBeenCalledWith(c);
});

test('release failure remains secondary to identity failure', async () => {
  const c = connection();
  const primary = new Error('identity read');
  const secondary = new Error('release');
  c.query.mockRejectedValue(primary);
  const p = pool(c);
  p.connectionManager.releaseConnection.mockRejectedValue(secondary);
  await expect(harness.verifyPools({ models: p })).rejects.toBe(primary);
  expect(primary.cleanupError).toBe(secondary);
});

function loader({ fail = null, closeFail = null } = {}) {
  const models = pool();
  const queries = pool();
  const app = { startServer: jest.fn() };
  if (closeFail) models.close.mockRejectedValue(closeFail);
  const verify = jest.fn(async () => { if (fail) throw fail; return { models: identity(), queries: identity() }; });
  const loaded = loadSource('test/harness/app.js', {
    '../../config/integrationHarness': {
      loadHarnessConfig: jest.fn(), verifyPools: verify,
      withHarnessImports: (_, callback) => callback(),
    },
    './externalGuards': { assertExternalGuards: jest.fn() },
    '../../src/models': { sequelize: models }, '../../src/config/database': queries,
    '../../src/index': app,
  }, { process: { env: { TEAMOFF_HARNESS_ENABLE: 'approved' } } }).exports;
  return { ...loaded, models, queries, app, verify };
}

test('harness imports Express without startServer and loads and closes only once', async () => {
  const s = loader();
  const [first, second] = await Promise.all([s.loadHarnessApp(), s.loadHarnessApp()]);
  expect(first).toBe(second);
  expect(s.verify).toHaveBeenCalledTimes(1);
  expect(s.app.startServer).not.toHaveBeenCalled();
  await Promise.all([s.closeHarness(), s.closeHarness()]);
  expect(s.models.close).toHaveBeenCalledTimes(1);
  expect(s.queries.close).toHaveBeenCalledTimes(1);
  await expect(s.loadHarnessApp()).rejects.toThrow(/fermé/);
});

test('loader identity failure closes both pools and keeps cleanup errors secondary', async () => {
  const primary = new Error('wrong identity');
  const s = loader({ fail: primary, closeFail: new Error('close model pool failed') });
  await expect(s.loadHarnessApp()).rejects.toBe(primary);
  expect(primary.cleanupError.name).toBe('AggregateError');
  expect(primary.cleanupError.errors).toHaveLength(1);
  expect(s.queries.close).toHaveBeenCalledTimes(1);
});

test('closing during identity verification drains it without importing Express or double-closing pools', async () => {
  const s = loader();
  let finish;
  s.verify.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const loading = s.loadHarnessApp();
  const closing = s.closeHarness();
  expect(s.models.close).not.toHaveBeenCalled();
  finish({});
  await expect(loading).rejects.toThrow(/fermé pendant/);
  await closing;
  expect(s.models.close).toHaveBeenCalledTimes(1);
  expect(s.queries.close).toHaveBeenCalledTimes(1);
  expect(s.app.startServer).not.toHaveBeenCalled();
});

test('future online guards accept only the explicit pg target, with entirely simulated transports', () => {
  class Client {
    constructor(parameters) { this.connectionParameters = parameters; }
    connect() { return 'simulated-connect'; }
  }
  class Socket { connect() { return 'simulated-tcp'; } }
  const childProcess = Object.fromEntries(
    ['exec', 'execFile', 'execSync', 'execFileSync', 'spawn', 'spawnSync', 'fork']
      .map(key => [key, jest.fn()]));
  const dns = Object.fromEntries(
    ['lookup', 'resolve', 'resolve4', 'resolve6', 'resolveMx'].map(key => [key, jest.fn()]));
  dns.promises = Object.fromEntries(
    ['lookup', 'resolve', 'resolve4', 'resolve6', 'resolveMx'].map(key => [key, jest.fn()]));
  const fakeGlobal = { fetch: jest.fn(), setInterval: jest.fn() };
  const guards = loadSource('test/harness/externalGuards.js', {
    child_process: childProcess, net: { Socket }, dns,
    tls: { connect: jest.fn() }, dgram: { createSocket: jest.fn() },
    http2: { connect: jest.fn() }, pg: { Client },
    '../../config/integrationHarness': harness,
  }, { jest: { fn: jest.fn, doMock: jest.fn(), spyOn: jest.spyOn }, global: fakeGlobal }).exports;
  guards.installExternalGuards({ allowDatabase: true });
  expect(() => guards.assertExternalGuards()).not.toThrow();
  const parameters = {
    host: harness.target.host, port: 5432, database: harness.target.database, user: harness.target.role,
  };
  expect(new Client(parameters).connect()).toBe('simulated-connect');
  for (const change of [
    { database: 'teamoff' }, { database: 'teamoff_notifications_test' },
    { user: 'postgres' }, { host: 'remote.invalid' }, { port: 5433 },
  ]) {
    expect(() => new Client({ ...parameters, ...change }).connect()).toThrow(/non autorisée/);
  }
  expect(new Socket().connect({ host: '127.0.0.1', port: 12345 })).toBe('simulated-tcp');
  expect(() => new Socket().connect({ host: 'external.invalid', port: 80 })).toThrow(/TCP/);
  expect(() => new Socket().connect({ path: '/tmp/.s.PGSQL.5432' })).toThrow(/TCP/);
});

test('offline barriers reject real PostgreSQL, email, Drive, Redis, cron, sockets and network', async () => {
  expect(() => new (require('pg').Client)({ connectionString: url }).connect()).toThrow(/PostgreSQL réel/);
  expect(() => require('nodemailer').createTransport()).toThrow(/SMTP/);
  expect(() => new (require('googleapis').google.auth.OAuth2)()).toThrow(/OAuth/);
  expect(() => require('googleapis').google.gmail()).toThrow(/Gmail/);
  expect(() => new (require('resend').Resend)()).toThrow(/Resend/);
  expect(() => new (require('ioredis'))()).toThrow(/Redis/);
  expect(() => require('node-cron').schedule()).toThrow(/cron/);
  expect(() => new (require('socket.io').Server)()).toThrow(/Socket.IO/);
  expect(() => setInterval(() => {}, 1000)).toThrow(/intervalle/);
  expect(() => fetch('https://external.invalid')).toThrow(/fetch/);
  expect(() => require('dns').promises.resolveMx('external.invalid')).toThrow(/DNS/);
  expect(() => require('net').connect({ host: '127.0.0.1', port: 5432 })).toThrow(/TCP/);
  expect(() => require('child_process').execFile('pg_dump')).toThrow(/execFile/);
  expect(() => require('../../src/services/backupService').runDatabaseBackup()).toThrow(/backup/);
  expect(() => require('../../src/services/googleDriveService').downloadFromDrive('id')).toThrow(/Drive/);
});

test('real Express import and both real pool constructors are inert in the harness', async () => {
  const previous = process.env;
  process.env = { ...env(), JWT_SECRET: 'simulation-only-secret-at-least-32-characters' };
  let app, models, queries;
  try {
    jest.isolateModules(() => {
      const scoped = require('../../config/integrationHarness');
      expect(() => require('../../src/index')).toThrow(/Import direct/);
      expect(() => require('../../src/models')).toThrow(/Import direct/);
      expect(() => require('../../src/config/database')).toThrow(/Import direct/);
      scoped.withHarnessImports('app', () => {
        app = require('../../src/index');
        models = require('../../src/models').sequelize;
        queries = require('../../src/config/database');
      });
    });

    expect(typeof app).toBe('function');
    expect(models).not.toBe(queries);
    expect(models.options.hooks.afterConnect).toHaveLength(1);
    expect(queries.options.hooks.afterConnect).toHaveLength(2);
    expect(models.config.database).toBe(harness.target.database);
    expect(queries.config.database).toBe(harness.target.database);
    expect(require('dotenv').config).not.toHaveBeenCalled();
    expect(require('pg').Client.prototype.connect).not.toHaveBeenCalled();
    expect(require('node-cron').schedule).not.toHaveBeenCalled();
    expect(global.setInterval).not.toHaveBeenCalled();
    const c = connection();
    for (const hook of queries.options.hooks.afterConnect) await hook(c);
    expect(c.query.mock.calls.map(call => call[0].trim().split(/\s+/)[0])).toEqual(['SELECT', 'SET', 'SET']);
    const refused = connection();
    refused.query.mockResolvedValue({ rows: [{ ...identity(), temporary: true }] });
    await expect((async () => {
      for (const hook of queries.options.hooks.afterConnect) await hook(refused);
    })()).rejects.toThrow(/pool queries/);
    expect(refused.query).toHaveBeenCalledTimes(1);
    expect(refused.end).toHaveBeenCalledTimes(1);
    await expect(app.startServer()).rejects.toThrow(/interdit/);
  } finally {
    if (app) await app.stopServer();
    else await Promise.all([models?.close(), queries?.close()]);
    process.env = previous;
  }
});

test.each(['models', 'queries'])('missing database owner is refused for %s', async name => {
  const c = connection();
  const actual = identity();
  delete actual.databaseOwner;
  c.query.mockResolvedValue({ rows: [actual] });
  await expect(harness.verifyConnection(c, name)).rejects.toThrow(/Identité/);
});

test.each([
  ['wrong table owner', o => { o[0].owner = 'unexpected'; }],
  ['missing table', o => { o.shift(); }],
  ['sequence', o => { o.push({ ...o[0], name: 'unexpected_seq', subtype: 'S' }); }],
  ['view', o => { o.push({ ...o[0], name: 'unexpected_view', subtype: 'v' }); }],
  ['materialized view', o => { o.push({ ...o[0], name: 'unexpected_mv', subtype: 'm' }); }],
  ['function', o => { o.push({ ...o.find(x => x.kind === 'function'), name: 'unexpected_function' }); }],
  ['extension identity', o => { o.find(x => x.name === 'uuid-ossp').version = 'unexpected'; }],
  ['extension membership', o => { o.find(x => x.kind === 'function').extension = null; }],
  ['SECURITY DEFINER', o => { o.find(x => x.kind === 'function').securityDefiner = true; }],
  ['UUID owner', o => { o.find(x => x.kind === 'function').owner = 'unexpected'; }],
  ['type owner', o => { o.find(x => x.kind === 'type').owner = 'unexpected'; }],
  ['another schema', o => { o[0].schema = 'other'; }],
])('catalog rejects %s independently of the connection identity', async (_, mutate) => {
  const actual = identity();
  mutate(actual.objects);
  const c = connection();
  c.query.mockResolvedValue({ rows: [actual] });
  await expect(harness.verifyConnection(c, 'models')).rejects.toThrow(/Ownership/);
});

test.each([undefined, null, [], {}, 'invalid'])('absent or invalid catalog %j fails closed', async catalog => {
  const c = connection();
  c.query.mockResolvedValue({ rows: [{ ...identity(), objects: catalog }] });
  await expect(harness.verifyConnection(c, 'queries')).rejects.toThrow(/Ownership/);
});

test('legitimate extension member owner exception is accepted, not generalized', () => {
  expect(() => harness.verifyObjects(objects(), 'models')).not.toThrow();
  const bad = objects();
  bad.find(x => x.kind === 'function').name = 'another_extension_member';
  expect(() => harness.verifyObjects(bad, 'models')).toThrow(/Ownership/);
});

test('first pool refusal prevents acquisition of the second pool', async () => {
  const models = pool();
  models.connectionManager.getConnection.mockRejectedValue(new Error('first pool'));
  const queries = pool();
  await expect(harness.verifyPools({ models, queries })).rejects.toThrow(/first pool/);
  expect(queries.connectionManager.getConnection).not.toHaveBeenCalled();
});

test('import permission is synchronous, scoped and restored after errors', () => {
  expect(() => harness.assertHarnessImport('pools')).toThrow(/Import direct/);
  expect(() => harness.withHarnessImports('pools', () => {
    harness.assertHarnessImport('pools');
    harness.assertHarnessImport('app');
  })).toThrow(/Import direct/);
  expect(() => harness.assertHarnessImport('pools')).toThrow(/Import direct/);
});

test('a cached unprotected pool is rejected before acquisition', async () => {
  const getConnection = jest.fn();
  await expect(harness.verifyPools({
    models: { connectionManager: { getConnection } },
  })).rejects.toThrow(/non protégé/);
  expect(getConnection).not.toHaveBeenCalled();
});

test('installing pool protection twice does not duplicate hooks', () => {
  const value = { addHook: jest.fn() };
  harness.protectPool(value, 'models');
  harness.protectPool(value, 'models');
  expect(value.addHook).toHaveBeenCalledTimes(1);
});
