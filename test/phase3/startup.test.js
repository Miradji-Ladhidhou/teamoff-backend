'use strict';

const { loadSource } = require('./loadSource');
const { verifyStartupSchema } = require('../../src/services/startupSchemaService');
const { QueryTypes, DataTypes } = require('sequelize');
const statuses = ['reserve', 'en_attente_manager', 'valide_manager', 'refuse_manager', 'valide_final', 'refuse_final'];

test.each([statuses, [...statuses].reverse(), [...statuses, 'future_status']].map(s => [s]))(
  'compatible schema accepts values regardless of order: %j', async labels => {
    const db = { query: jest.fn().mockResolvedValue(labels.map(label => ({ label }))) };
    await verifyStartupSchema(db);
    expect(db.query).toHaveBeenCalledTimes(1);
    const [sql, options] = db.query.mock.calls[0];
    expect(sql.trim()).toMatch(/^SELECT /);
    expect(sql).not.toMatch(/\b(ALTER|CREATE|DROP|INSERT|UPDATE|DELETE)\b/i);
    expect(sql).toContain("a.attname = 'statut'");
    expect(sql).toContain("tn.nspname = 'public'");
    expect(options.type).toBe(QueryTypes.SELECT);
  }
);

test.each(statuses)('missing %s fails without repairing schema', async missing => {
  const db = { query: jest.fn().mockResolvedValue(statuses.filter(s => s !== missing).map(label => ({ label }))) };
  await expect(verifyStartupSchema(db)).rejects.toThrow(missing);
  expect(db.query).toHaveBeenCalledTimes(1);
});

test('missing table, column or type fails explicitly', async () => {
  await expect(verifyStartupSchema({ query: jest.fn().mockResolvedValue([]) })).rejects.toThrow(/Schéma PostgreSQL incompatible/);
});

test('catalog read error is not swallowed', async () => {
  const error = new Error('catalog unavailable');
  await expect(verifyStartupSchema({ query: jest.fn().mockRejectedValue(error) })).rejects.toBe(error);
});

test('model status values remain covered by startup check', () => {
  const define = jest.fn();
  require('../../src/models/Conge')({ define }, DataTypes);
  expect(define.mock.calls[0][1].statut.type.values).toEqual(statuses);
});

function startup(db, main = false) {
  const app = { set: jest.fn(), use: jest.fn(), get: jest.fn() };
  const express = Object.assign(() => app, { json: () => jest.fn() });
  const logger = { info: jest.fn(), error: jest.fn() };
  const server = new (require('events').EventEmitter)();
  server.listening = false;
  server.listen = jest.fn(() => {
    server.listening = true;
    server.emit('listening');
  });
  server.close = jest.fn(callback => {
    server.listening = false;
    callback();
  });
  const cron = jest.fn();
  const closeCron = jest.fn();
  const sockets = { initialize: jest.fn(), close: jest.fn() };
  const sse = { initialize: jest.fn(), stop: jest.fn() };
  const limiter = { generalLimiter: jest.fn(), initialize: jest.fn(), stop: jest.fn() };
  const advancedLimiter = { initialize: jest.fn(), stop: jest.fn() };
  const queryDb = { close: jest.fn() };
  db.close = db.close || jest.fn();
  const dependencies = {
    dotenv: { config: jest.fn() }, dns: { setDefaultResultOrder: jest.fn() },
    express, './utils/logger': logger, compression: () => jest.fn(),
    http: { createServer: jest.fn(() => server) }, './models': { sequelize: db },
    './routes': {}, './middlewares/metrics': { metricsMiddleware: jest.fn() },
    './middlewares/rateLimiter': limiter,
    './middlewares/advancedRateLimiter': advancedLimiter,
    './config/database': queryDb,
    './middlewares/errorHandler': jest.fn(),
    './services/notificationSocketService': sockets,
    './services/sseManager': sse,
    './middlewares/maintenanceMode': jest.fn(),
    './cron/backupCron': { initBackupCron: cron, stopBackupCron: closeCron },
    './cron/quotasCron': { initQuotasCron: cron, stopQuotasCron: closeCron },
    './cron/emailCron': { initEmailCron: cron, stopEmailCron: closeCron },
    cors: jest.fn(() => jest.fn()), helmet: () => jest.fn(), 'cookie-parser': () => jest.fn(),
    './middlewares/sanitizeInput': jest.fn(), './middlewares/requestId': jest.fn(),
    './middlewares/requestLogger': jest.fn(),
    './services/startupSchemaService': { verifyStartupSchema },
    './services/backendLifecycle': require('../../src/services/backendLifecycle'),
    './utils/sanitizeLogData': require('../../src/utils/sanitizeLogData'),
  };
  const env = Object.fromEntries(['JWT_SECRET', 'JWT_REFRESH_SECRET', 'DATABASE_URL', 'MAIL_HOST', 'MAIL_USER',
    'MAIL_PASS', 'MAIL_SECURE', 'EMAIL_FROM', 'FRONTEND_URL'].map(key => [key, 'simulation-only-value-at-least-32-characters']));
  const process = { env, exit: jest.fn(), on: jest.fn() };
  const loaded = loadSource('src/index.js', dependencies, { process }, '', main);
  return {
    ...loaded.exports, process, logger, server, cron, closeCron, sockets, sse,
    limiter, advancedLimiter, db, queryDb, createServer: dependencies.http.createServer,
    cors: dependencies.cors,
  };
}

test('actual startup authenticates, checks schema then starts unchanged cron jobs', async () => {
  const db = { authenticate: jest.fn().mockResolvedValue(), query: jest.fn().mockResolvedValue(statuses.map(label => ({ label }))) };
  const s = startup(db);
  await s.startServer();
  expect(db.authenticate).toHaveBeenCalledTimes(1);
  expect(db.query).toHaveBeenCalledTimes(1);
  expect(s.cron).toHaveBeenCalledTimes(3);
  expect(s.server.listen).toHaveBeenCalledWith(5500);
  expect(s.process.exit).not.toHaveBeenCalled();
});

test('incompatible startup rejects and closes its pool before resources or cron jobs', async () => {
  const s = startup({ authenticate: jest.fn().mockResolvedValue(), query: jest.fn().mockResolvedValue([]) });
  await expect(s.startServer()).rejects.toThrow('incompatible');
  expect(s.db.close).toHaveBeenCalledTimes(1);
  expect(s.sockets.initialize).not.toHaveBeenCalled();
  expect(s.sse.initialize).not.toHaveBeenCalled();
  expect(s.cron).not.toHaveBeenCalled();
  expect(s.createServer).not.toHaveBeenCalled();
  expect(s.server.listen).not.toHaveBeenCalled();
});

test('importing the Express app never initializes active resources', () => {
  const s = startup({});
  expect(s.sockets.initialize).not.toHaveBeenCalled();
  expect(s.sse.initialize).not.toHaveBeenCalled();
  expect(s.limiter.initialize).not.toHaveBeenCalled();
  expect(s.advancedLimiter.initialize).not.toHaveBeenCalled();
  expect(s.cron).not.toHaveBeenCalled();
  expect(s.cors).toHaveBeenCalledWith(expect.objectContaining({
    exposedHeaders: ['X-TeamOff-Warning'], credentials: true,
  }));
});

test('normal startup ordering preserves schema, sockets, SSE, cron and HTTP sequence', async () => {
  const s = startup({ authenticate: jest.fn(), query: jest.fn().mockResolvedValue(statuses.map(label => ({ label }))) });
  await s.startServer();
  const order = fn => fn.mock.invocationCallOrder[0];
  expect(order(s.db.query)).toBeLessThan(order(s.sockets.initialize));
  expect(order(s.sockets.initialize)).toBeLessThan(order(s.sse.initialize));
  expect(order(s.sse.initialize)).toBeLessThan(order(s.cron));
  expect(order(s.cron)).toBeLessThan(order(s.server.listen));
  await s.stopServer();
});

test('repeated startup and shutdown initialize and clean each resource once', async () => {
  const s = startup({ authenticate: jest.fn(), query: jest.fn().mockResolvedValue(statuses.map(label => ({ label }))) });
  expect(s.startServer()).toBe(s.startServer());
  await s.startServer();
  expect(s.stopServer()).toBe(s.stopServer());
  await s.stopServer();
  expect(s.sockets.initialize).toHaveBeenCalledTimes(1);
  expect(s.sse.initialize).toHaveBeenCalledTimes(1);
  expect(s.sockets.close).toHaveBeenCalledTimes(1);
  expect(s.sse.stop).toHaveBeenCalledTimes(1);
  expect(s.closeCron).toHaveBeenCalledTimes(3);
  expect(s.server.close).toHaveBeenCalledTimes(1);
  expect(s.db.close).toHaveBeenCalledTimes(1);
  expect(s.queryDb.close).toHaveBeenCalledTimes(1);
  const order = fn => fn.mock.invocationCallOrder[0];
  expect(order(s.server.close)).toBeLessThan(order(s.closeCron));
  expect(order(s.closeCron)).toBeLessThan(order(s.sse.stop));
  expect(order(s.sse.stop)).toBeLessThan(order(s.sockets.close));
  expect(order(s.sockets.close)).toBeLessThan(order(s.queryDb.close));
  expect(order(s.queryDb.close)).toBeLessThan(order(s.db.close));
});

test('HTTP listen errors reject startup, stop crons and close both historical pools', async () => {
  const s = startup({ authenticate: jest.fn(), query: jest.fn().mockResolvedValue(statuses.map(label => ({ label }))) });
  const error = Object.assign(new Error('address in use'), { code: 'EADDRINUSE' });
  s.server.listen.mockImplementation(() => s.server.emit('error', error));
  await expect(s.startServer()).rejects.toBe(error);
  expect(s.closeCron).toHaveBeenCalledTimes(3);
  expect(s.sse.stop).toHaveBeenCalledTimes(1);
  expect(s.sockets.close).toHaveBeenCalledTimes(1);
  expect(s.db.close).toHaveBeenCalledTimes(1);
  expect(s.queryDb.close).toHaveBeenCalledTimes(1);
});

test('environment errors reject before authentication and never continue after a mocked exit', async () => {
  const s = startup({ authenticate: jest.fn() });
  delete s.process.env.JWT_SECRET;
  await expect(s.startServer()).rejects.toThrow('JWT_SECRET');
  expect(s.db.authenticate).not.toHaveBeenCalled();
  expect(s.db.close).toHaveBeenCalledTimes(1);
  expect(s.process.exit).not.toHaveBeenCalled();
});

test('main entry validates before importing the second pool or creating resources', async () => {
  let finish;
  const query = jest.fn(() => new Promise(resolve => { finish = resolve; }));
  const s = startup({ authenticate: jest.fn(), query }, true);
  await Promise.resolve();
  expect(query).toHaveBeenCalledTimes(1);
  expect(s.sockets.initialize).not.toHaveBeenCalled();
  expect(s.sse.initialize).not.toHaveBeenCalled();
  expect(s.limiter.initialize).not.toHaveBeenCalled();
  expect(s.cron).not.toHaveBeenCalled();
  expect(s.createServer).not.toHaveBeenCalled();
  finish([]);
  await expect(s.startServer()).rejects.toThrow('incompatible');
  await s.stopServer();
  expect(s.queryDb.close).not.toHaveBeenCalled();
  expect(s.process.exitCode).toBe(1);
  expect(s.process.exit).not.toHaveBeenCalled();
});

test('repeated signals share shutdown and close all resources once', async () => {
  const s = startup({
    authenticate: jest.fn(), query: jest.fn().mockResolvedValue(statuses.map(label => ({ label }))),
  }, true);
  await s.startServer();
  const handlers = Object.fromEntries(s.process.on.mock.calls);
  expect(handlers.SIGTERM()).toBe(handlers.SIGINT());
  handlers.SIGTERM();
  await s.stopServer();
  expect(s.closeCron).toHaveBeenCalledTimes(3);
  expect(s.sse.stop).toHaveBeenCalledTimes(1);
  expect(s.db.close).toHaveBeenCalledTimes(1);
  expect(s.queryDb.close).toHaveBeenCalledTimes(1);
});

test('a cron cleanup error cannot stop cleanup of other groups or pools', async () => {
  const s = startup({
    authenticate: jest.fn(), query: jest.fn().mockResolvedValue(statuses.map(label => ({ label }))),
  });
  await s.startServer();
  s.closeCron.mockImplementationOnce(() => { throw new Error('backup cron stop failed'); });
  await expect(s.stopServer()).rejects.toThrow('Arrêt du backend incomplet');
  expect(s.closeCron).toHaveBeenCalledTimes(3);
  expect(s.sse.stop).toHaveBeenCalledTimes(1);
  expect(s.sockets.close).toHaveBeenCalledTimes(1);
  expect(s.db.close).toHaveBeenCalledTimes(1);
  expect(s.queryDb.close).toHaveBeenCalledTimes(1);
});
