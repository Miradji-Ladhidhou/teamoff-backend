'use strict';

const { EventEmitter } = require('events');
const { loadSource } = require('./loadSource');
const { createBackendLifecycle, listenHttp, closeHttp } = require('../../src/services/backendLifecycle');
const { createCronTaskGroup } = require('../../src/services/cronTaskGroup');
const logger = { error: jest.fn(), info: jest.fn(), warn: jest.fn() };

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('schema failure cleans validation resources, never initializing runtime resources', async () => {
  const error = new Error('schema incompatible');
  const close = jest.fn();
  const initialize = jest.fn();
  const listen = jest.fn();
  const lifecycle = createBackendLifecycle({
    logger, validate: async register => { register('database', close); throw error; },
    initialize, listen,
  });
  await expect(lifecycle.start()).rejects.toBe(error);
  await lifecycle.stop();
  expect(close).toHaveBeenCalledTimes(1);
  expect(initialize).not.toHaveBeenCalled();
  expect(listen).not.toHaveBeenCalled();
});

test('cleanup failures remain secondary and cannot prevent later pool cleanup', async () => {
  const primary = new Error('schema incompatible');
  const cleanup = new Error('cleanup failed password=synthetic-secret');
  const closePool = jest.fn();
  const lifecycle = createBackendLifecycle({
    logger, validate: async register => {
      register('pool', closePool);
      register('failing resource', () => { throw cleanup; });
      throw primary;
    }, initialize: jest.fn(), listen: jest.fn(),
  });
  await expect(lifecycle.start()).rejects.toBe(primary);
  expect(primary.cleanupErrors).toEqual([cleanup]);
  expect(cleanup.message).toBe('cleanup failed password=***');
  expect(closePool).toHaveBeenCalledTimes(1);
  await lifecycle.stop();
  expect(closePool).toHaveBeenCalledTimes(1);
});

test('normal shutdown reports all failures and cleans remaining resources only once', async () => {
  const close = jest.fn();
  const lifecycle = createBackendLifecycle({
    logger, validate: jest.fn(),
    initialize: async register => {
      register('pool', close);
      register('SSE', () => { throw new Error('SSE cleanup failed'); });
      register('socket', () => { throw new Error('socket cleanup failed'); });
    }, listen: jest.fn(),
  });
  await lifecycle.start();
  const stop = lifecycle.stop();
  expect(lifecycle.stop()).toBe(stop);
  await expect(stop).rejects.toMatchObject({ errors: expect.arrayContaining([
    expect.objectContaining({ message: 'socket cleanup failed' }),
    expect.objectContaining({ message: 'SSE cleanup failed' }),
  ]) });
  expect(close).toHaveBeenCalledTimes(1);
});

test('stop requested during validation prevents initialization and waits before closing the pool', async () => {
  const gate = deferred();
  const close = jest.fn();
  const initialize = jest.fn();
  const lifecycle = createBackendLifecycle({
    logger, validate: async register => { register('pool', close); await gate.promise; },
    initialize, listen: jest.fn(),
  });
  const start = lifecycle.start();
  const stop = lifecycle.stop();
  expect(close).not.toHaveBeenCalled();
  gate.resolve();
  await expect(start).rejects.toThrow('interrompu');
  await stop;
  expect(initialize).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledTimes(1);
});

test('partial resource initialization is cleaned if initialization throws', async () => {
  const close = jest.fn();
  const primary = new Error('socket initialization failed');
  const listen = jest.fn();
  const lifecycle = createBackendLifecycle({
    logger, validate: jest.fn(),
    initialize: async register => { register('socket', close); throw primary; }, listen,
  });
  await expect(lifecycle.start()).rejects.toBe(primary);
  expect(close).toHaveBeenCalledTimes(1);
  expect(listen).not.toHaveBeenCalled();
});

test('stop before start cleans registered resources and refuses a subsequent start', async () => {
  const close = jest.fn();
  const validate = jest.fn();
  const lifecycle = createBackendLifecycle({ logger, validate, initialize: jest.fn(), listen: jest.fn() });
  lifecycle.register('pool', close);
  await lifecycle.stop();
  await expect(lifecycle.start()).rejects.toThrow('arrêté');
  expect(close).toHaveBeenCalledTimes(1);
  expect(validate).not.toHaveBeenCalled();
});

test('HTTP listen success and failure are handled without a real listener', async () => {
  const server = new EventEmitter();
  server.listen = jest.fn(() => server.emit('listening'));
  await listenHttp(server, 5500);
  expect(server.listenerCount('listening')).toBe(0);
  expect(server.listenerCount('error')).toBe(0);
  const error = new Error('address in use');
  server.listen.mockImplementation(() => server.emit('error', error));
  await expect(listenHttp(server, 5500)).rejects.toBe(error);
  expect(server.listenerCount('listening')).toBe(0);
});

test('HTTP cleanup tolerates an already stopped server and closes idle connections', async () => {
  const server = { listening: false, close: jest.fn(), closeIdleConnections: jest.fn() };
  await closeHttp(server);
  expect(server.close).not.toHaveBeenCalled();
  server.listening = true;
  server.close.mockImplementation(callback => callback());
  await closeHttp(server);
  expect(server.closeIdleConnections).toHaveBeenCalledTimes(1);
});

test('a stop during runtime initialization cleans initialized resources without listening', async () => {
  const gate = deferred();
  const initialized = deferred();
  const close = jest.fn();
  const listen = jest.fn();
  const lifecycle = createBackendLifecycle({
    logger, validate: jest.fn(),
    initialize: async register => {
      register('socket', close);
      initialized.resolve();
      await gate.promise;
    }, listen,
  });
  const start = lifecycle.start();
  await initialized.promise;
  const stop = lifecycle.stop();
  gate.resolve();
  await expect(start).rejects.toThrow('interrompu');
  await stop;
  expect(listen).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledTimes(1);
});

test('a pool close failure is explicit on shutdown without skipping the other pool', async () => {
  const primary = new Error('query pool close failed');
  const modelClose = jest.fn();
  const lifecycle = createBackendLifecycle({ logger, validate: jest.fn(), initialize: jest.fn(), listen: jest.fn() });
  lifecycle.register('model pool', modelClose);
  lifecycle.register('query pool', () => { throw primary; });
  await lifecycle.start();
  await expect(lifecycle.stop()).rejects.toMatchObject({ errors: [primary] });
  expect(modelClose).toHaveBeenCalledTimes(1);
});

function sse() {
  const timers = new Map();
  let nextId = 0;
  const setInterval = jest.fn(fn => { timers.set(++nextId, fn); return nextId; });
  const clearInterval = jest.fn(id => timers.delete(id));
  const service = loadSource('src/services/sseManager.js', {
    '../utils/logger': logger, '../utils/sanitizeLogData': require('../../src/utils/sanitizeLogData'),
  }, {
    setInterval, clearInterval,
  }).exports;
  return { service, timers, setInterval, clearInterval };
}

test('SSE import is inert, initialization and stop are idempotent', () => {
  const s = sse();
  expect(s.setInterval).not.toHaveBeenCalled();
  s.service.initialize();
  s.service.initialize();
  expect(s.setInterval).toHaveBeenCalledTimes(1);
  s.service.stop();
  s.service.stop();
  expect(s.clearInterval).toHaveBeenCalledTimes(1);
  expect(s.timers.size).toBe(0);
});

test('SSE stop releases every client even when another client cleanup fails', () => {
  const s = sse();
  const first = { end: jest.fn(), write: jest.fn() };
  const second = { end: jest.fn(), write: jest.fn() };
  const cleanup = jest.fn();
  s.service.initialize();
  s.service.addClient('first', first, () => { throw new Error('cleanup failed'); });
  s.service.addClient('second', second, cleanup);
  expect(() => s.service.stop()).toThrow('Arrêt SSE incomplet');
  expect(first.end).toHaveBeenCalledTimes(1);
  expect(second.end).toHaveBeenCalledTimes(1);
  expect(cleanup).toHaveBeenCalledTimes(1);
  expect(s.timers.size).toBe(0);
  s.service.stop();
  s.service.sendToUser('second', 'notification', {});
  expect(second.write).not.toHaveBeenCalled();
});

test('SSE messages and dead client purge remain compatible', () => {
  const s = sse();
  const res = { write: jest.fn(), writableEnded: false };
  const cleanup = jest.fn();
  s.service.addClient('user', res, cleanup);
  s.service.initialize();
  s.service.sendToUser('user', 'notification', { id: 'event' });
  expect(res.write).toHaveBeenCalledWith('event: notification\ndata: {"id":"event"}\n\n');
  res.writableEnded = true;
  [...s.timers.values()][0]();
  expect(cleanup).toHaveBeenCalledTimes(1);
  s.service.sendToUser('user', 'notification', {});
  expect(res.write).toHaveBeenCalledTimes(1);
  s.service.stop();
});

test('SSE route timers and connection counts are released on controlled shutdown', async () => {
  const s = sse();
  const timers = new Set();
  let handler;
  const router = { use: jest.fn(), put: jest.fn(), get: (name, fn) => { if (name === '/stream') handler = fn; } };
  const clearTimer = jest.fn(id => timers.delete(id));
  const allocate = jest.fn(() => { const id = {}; timers.add(id); return id; });
  loadSource('src/routes/notification.js', {
    express: { Router: () => router },
    jsonwebtoken: { verify: () => ({ id: 'user', exp: Date.now() / 1000 + 60 }) },
    '../models': {
      Utilisateur: { findByPk: async () => ({ id: 'user', entreprise_id: 'company', statut: 'actif' }) },
      Entreprise: { findByPk: async () => ({ statut: 'active' }) },
    },
    '../middlewares/authJwt': jest.fn(), '../middlewares/validateUUIDParam': () => jest.fn(),
    '../controllers/notificationController': {}, '../services/sseManager': s.service,
    '../utils/logger': logger, '../middlewares/authorizeRole': () => jest.fn(),
    '../services/notificationPreferencesService': {},
  }, { setInterval: allocate, setTimeout: allocate, clearInterval: clearTimer, clearTimeout: clearTimer });
  const req = Object.assign(new EventEmitter(), { query: { token: 'simulation' }, headers: {} });
  const res = Object.assign(new EventEmitter(), {
    setHeader: jest.fn(), flushHeaders: jest.fn(), write: jest.fn(), end: jest.fn(),
  });
  await handler(req, res);
  expect(timers.size).toBe(2);
  s.service.stop();
  expect(timers.size).toBe(0);
  expect(res.end).toHaveBeenCalledTimes(1);
  req.emit('close');
  res.emit('close');
  expect(clearTimer).toHaveBeenCalledTimes(2);
});

function cronMock() {
  const tasks = [];
  const cron = { schedule: jest.fn((expression, handler) => {
    const task = { expression, handler, stop: jest.fn(), destroy: jest.fn() };
    tasks.push(task);
    return task;
  }) };
  return { cron, tasks };
}

test('cron stop prevents new executions, drains running work and destroys only once', async () => {
  const { cron, tasks } = cronMock();
  const group = createCronTaskGroup(cron);
  const gate = deferred();
  const handler = jest.fn(() => gate.promise);
  group.schedule('* * * * *', handler);
  const execution = tasks[0].handler();
  await Promise.resolve();
  const stop = group.stop();
  expect(group.stop()).toBe(stop);
  let stopped = false;
  stop.then(() => { stopped = true; });
  await Promise.resolve();
  expect(stopped).toBe(false);
  await tasks[0].handler();
  expect(handler).toHaveBeenCalledTimes(1);
  gate.resolve();
  await execution;
  await stop;
  expect(tasks[0].stop).toHaveBeenCalledTimes(1);
  expect(tasks[0].destroy).toHaveBeenCalledTimes(1);
  expect(() => group.schedule('* * * * *', handler)).toThrow('arrêté');
});

test('cron cleanup attempts all tasks after a stop failure', async () => {
  const { cron, tasks } = cronMock();
  const group = createCronTaskGroup(cron);
  group.schedule('* * * * *', jest.fn());
  group.schedule('* * * * *', jest.fn());
  tasks[0].stop.mockImplementation(() => { throw new Error('stop failed'); });
  await expect(group.stop()).rejects.toThrow('Arrêt du groupe cron incomplet');
  expect(tasks[0].destroy).toHaveBeenCalledTimes(1);
  expect(tasks[1].stop).toHaveBeenCalledTimes(1);
  expect(tasks[1].destroy).toHaveBeenCalledTimes(1);
});

test.each(['quotas', 'email'])('%s cron import is inert and repeated initialization keeps original schedules', async kind => {
  const { cron, tasks } = cronMock();
  const common = {
    '../utils/sanitizeLogData': require('../../src/utils/sanitizeLogData'),
    'node-cron': cron, '../utils/logger': logger,
    '../services/cronTaskGroup': { createCronTaskGroup },
    '../models': {},
  };
  const dependencies = kind === 'quotas' ? {
    ...common, '../services/quotasService': {}, '../services/congesService': {},
  } : {
    ...common, dayjs: {}, sequelize: { Op: {} },
    '../services/emailService': {}, '../services/leaveNotificationRecipients': {},
    '../services/politiqueConges': {}, '../services/managerCrossServicePolicy': {},
    '../services/notificationService': {}, '../utils/dateFormatter': {},
    '../services/businessNotificationContext': {}, '../services/notificationPreferencesService': {},
  };
  const service = loadSource(`src/cron/${kind}Cron.js`, dependencies).exports;
  expect(cron.schedule).not.toHaveBeenCalled();
  const init = kind === 'quotas' ? service.initQuotasCron : service.initEmailCron;
  const stop = kind === 'quotas' ? service.stopQuotasCron : service.stopEmailCron;
  init(); init();
  expect(tasks.map(task => task.expression)).toEqual(kind === 'quotas'
    ? ['0 0 1 1 *', '5 0 1 2-12 *', '5 2 1 1 *']
    : ['0 8 * * *', '0 9 * * *', '0 7 1 * *', '0 10 * * *', '0 7 * * 1', '30 8 * * *']);
  await stop(); await stop();
  for (const task of tasks) {
    expect(task.stop).toHaveBeenCalledTimes(1);
    expect(task.destroy).toHaveBeenCalledTimes(1);
  }
});

test('backup initialization is serialized and frequency changes retire the previous task', async () => {
  const { cron, tasks } = cronMock();
  const getSettings = jest.fn().mockResolvedValue({ dbBackupFrequency: 'daily' });
  const service = loadSource('src/cron/backupCron.js', {
    'node-cron': cron, '../utils/logger': logger,
    '../utils/sanitizeLogData': require('../../src/utils/sanitizeLogData'),
    '../services/systemSettingsService': { getSettings },
    '../services/backupService': {}, '../services/cronTaskGroup': { createCronTaskGroup },
  }).exports;
  const first = service.initBackupCron();
  expect(service.initBackupCron()).toBe(first);
  await first;
  await service.initBackupCron();
  expect(cron.schedule).toHaveBeenCalledTimes(1);
  getSettings.mockResolvedValue({ dbBackupFrequency: 'weekly' });
  await service.initBackupCron();
  expect(tasks.map(task => task.expression)).toEqual(['0 2 * * *', '0 2 * * 0']);
  await service.stopBackupCron(); await service.stopBackupCron();
  for (const task of tasks) {
    expect(task.stop).toHaveBeenCalledTimes(1);
    expect(task.destroy).toHaveBeenCalledTimes(1);
  }
});

test('backup stop during settings lookup prevents delayed task creation', async () => {
  const { cron } = cronMock();
  const gate = deferred();
  const service = loadSource('src/cron/backupCron.js', {
    'node-cron': cron, '../utils/logger': logger,
    '../utils/sanitizeLogData': require('../../src/utils/sanitizeLogData'),
    '../services/systemSettingsService': { getSettings: () => gate.promise },
    '../services/backupService': {}, '../services/cronTaskGroup': { createCronTaskGroup },
  }).exports;
  const init = service.initBackupCron();
  const stop = service.stopBackupCron();
  gate.resolve({ dbBackupFrequency: 'daily' });
  await init; await stop;
  expect(cron.schedule).not.toHaveBeenCalled();
});

test('Socket.IO import is inert and repeated initialization and closure are idempotent', async () => {
  const io = { use: jest.fn(), on: jest.fn(), close: jest.fn(cb => cb()), to: jest.fn(() => ({ emit: jest.fn() })) };
  const Server = jest.fn(() => io);
  const service = loadSource('src/services/notificationSocketService.js', {
    'socket.io': { Server }, jsonwebtoken: {}, '../models': {},
    './politiqueConges': {}, './managerCrossServicePolicy': {}, './systemSettingsService': {},
    '../utils/logger': logger, './businessNotificationContext': {},
    './commentVisibilityService': {},
  }).exports;
  expect(Server).not.toHaveBeenCalled();
  const server = {};
  expect(service.initialize(server)).toBe(io);
  expect(service.initialize(server)).toBe(io);
  expect(Server).toHaveBeenCalledTimes(1);
  expect(io.on).toHaveBeenCalledWith('connection', expect.any(Function));
  service.connectedUsers.set('user', 'socket');
  const close = service.close();
  expect(service.close()).toBe(close);
  await close;
  expect(io.close).toHaveBeenCalledTimes(1);
  expect(service.getConnectedUsersCount()).toBe(0);
  expect(service.notifyUserLegacy('user', 'event', {})).toBe(false);
  expect(() => service.initialize(server)).toThrow('arrêté');
});

test('memory rate limit timers are explicitly initialized and shut down, never at import', () => {
  const started = jest.fn();
  const stopped = jest.fn();
  class MemoryStore {
    init() { started(); }
    shutdown() { stopped(); }
  }
  const rateLimit = Object.assign(options => { options.store.init(options); return jest.fn(); }, { MemoryStore });
  const limiter = loadSource('src/middlewares/rateLimiter.js', { 'express-rate-limit': rateLimit }).exports;
  expect(started).not.toHaveBeenCalled();
  limiter.initialize(); limiter.initialize();
  expect(started).toHaveBeenCalledTimes(2);
  limiter.stop(); limiter.stop();
  expect(stopped).toHaveBeenCalledTimes(2);
});

test('optional Redis connection is deferred and closed only once', async () => {
  const client = { on: jest.fn(), quit: jest.fn().mockResolvedValue(), disconnect: jest.fn() };
  const Redis = jest.fn(() => client);
  const limiter = loadSource('src/middlewares/advancedRateLimiter.js', {
    'rate-limiter-flexible': {}, '../config/rateLimitConfig': {},
    '../utils/sanitizeLogData': require('../../src/utils/sanitizeLogData'),
    '../utils/logger': logger, ioredis: Redis,
  }, { process: { env: { REDIS_URL: 'redis://localhost/simulation' } } }).exports;
  expect(Redis).not.toHaveBeenCalled();
  limiter.initialize(); limiter.initialize();
  expect(Redis).toHaveBeenCalledTimes(1);
  await limiter.stop(); await limiter.stop();
  expect(client.quit).toHaveBeenCalledTimes(1);
  expect(client.disconnect).toHaveBeenCalledTimes(1);
});

test('Redis disconnect failure cannot mask the initial quit failure', async () => {
  const primary = new Error('quit failed');
  const client = {
    on: jest.fn(), quit: jest.fn().mockRejectedValue(primary),
    disconnect: jest.fn(() => { throw new Error('disconnect failed'); }),
  };
  const limiter = loadSource('src/middlewares/advancedRateLimiter.js', {
    'rate-limiter-flexible': {}, '../config/rateLimitConfig': {},
    '../utils/sanitizeLogData': require('../../src/utils/sanitizeLogData'),
    '../utils/logger': logger, ioredis: jest.fn(() => client),
  }, { process: { env: { REDIS_URL: 'redis://localhost/simulation' } } }).exports;
  limiter.initialize();
  await expect(limiter.stop()).rejects.toBe(primary);
  expect(primary.cleanupError.message).toBe('disconnect failed');
});

test('aggregate cleanup errors are sanitized recursively without replacing the primary error', () => {
  const primary = Object.assign(new Error('startup failed'), {
    cleanupErrors: [new AggregateError([new Error('password=synthetic-secret')], 'cron cleanup failed')],
  });
  require('../../src/utils/sanitizeLogData').sanitizeError(primary);
  expect(primary.message).toBe('startup failed');
  expect(primary.cleanupErrors[0].errors[0].message).toBe('password=***');
});
