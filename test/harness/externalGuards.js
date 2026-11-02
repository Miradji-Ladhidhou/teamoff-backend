'use strict';

let databaseAllowed = false;

function assertExternalGuards() {
  if (!databaseAllowed) throw new Error('Barrières du harness réel non installées.');
}

function installExternalGuards({ allowDatabase = false } = {}) {
  const deny = name => jest.fn(() => {
    throw new Error(`Harness : effet externe interdit (${name}).`);
  });
  jest.doMock('dotenv', () => ({
    ...jest.requireActual('dotenv'), config: jest.fn(() => ({ parsed: {} })),
  }));
  // Node's native loader supports the installed ESM parser; Jest's CJS loader does not.
  jest.doMock('sanitize-html', () =>
    process.getBuiltinModule('module').createRequire(__filename)('sanitize-html'));
  jest.doMock('nodemailer', () => ({ createTransport: deny('SMTP') }));
  jest.doMock('googleapis', () => ({
    google: { auth: { OAuth2: deny('OAuth') }, gmail: deny('Gmail'), drive: deny('Drive') },
  }));
  jest.doMock('resend', () => ({ Resend: deny('Resend') }));
  jest.doMock('ioredis', () => deny('Redis'), { virtual: true });
  jest.doMock('node-cron', () => ({ schedule: deny('cron'), createTask: deny('cron') }));
  jest.doMock('socket.io', () => ({ Server: deny('Socket.IO') }));
  jest.doMock('../../src/services/googleDriveService', () => {
    const service = jest.requireActual('../../src/services/googleDriveService');
    return Object.fromEntries(Object.keys(service).map(key => [key, deny(`Drive.${key}`)]));
  });
  jest.doMock('../../src/services/backupService', () => {
    const service = jest.requireActual('../../src/services/backupService');
    return Object.fromEntries(Object.entries(service).map(([key, value]) =>
      [key, typeof value === 'function' ? deny(`backup.${key}`) : value]));
  });
  const childProcess = require('child_process');
  for (const name of ['exec', 'execFile', 'execSync', 'execFileSync', 'spawn', 'spawnSync', 'fork']) {
    jest.spyOn(childProcess, name).mockImplementation(deny(name));
  }
  jest.spyOn(global, 'setInterval').mockImplementation(deny('intervalle'));
  jest.spyOn(global, 'fetch').mockImplementation(deny('fetch'));
  jest.spyOn(require('tls'), 'connect').mockImplementation(deny('TLS'));
  jest.spyOn(require('dgram'), 'createSocket').mockImplementation(deny('UDP'));

  const loopback = host => ['127.0.0.1', '::1', 'localhost'].includes(host);
  const net = require('net');
  const originalConnect = net.Socket.prototype.connect;
  jest.spyOn(net.Socket.prototype, 'connect').mockImplementation(function (...args) {
    const options = Array.isArray(args[0]) ? args[0][0] : args[0];
    const host = typeof options === 'object' ? options.host : args[1];
    if (!allowDatabase || !loopback(host) || (typeof options === 'object' && options.path)) {
      return deny('TCP')();
    }
    return originalConnect.apply(this, args);
  });
  const dns = require('dns');
  const originalLookup = dns.lookup;
  jest.spyOn(dns, 'lookup').mockImplementation((hostname, ...args) => {
    if (!allowDatabase || !loopback(hostname)) return deny('DNS')();
    return originalLookup.call(dns, hostname, ...args);
  });
  for (const name of ['resolve', 'resolve4', 'resolve6', 'resolveMx']) {
    jest.spyOn(dns, name).mockImplementation(deny(`DNS.${name}`));
  }
  for (const name of ['lookup', 'resolve', 'resolve4', 'resolve6', 'resolveMx']) {
    jest.spyOn(dns.promises, name).mockImplementation(deny(`DNS promises.${name}`));
  }
  jest.spyOn(require('http2'), 'connect').mockImplementation(deny('HTTP/2'));
  const pg = require('pg');
  const originalPgConnect = pg.Client.prototype.connect;
  jest.spyOn(pg.Client.prototype, 'connect').mockImplementation(function (...args) {
    if (!allowDatabase) return deny('PostgreSQL réel')();
    const { target } = require('../../config/integrationHarness');
    const p = this.connectionParameters;
    if (p.host !== target.host || String(p.port) !== target.serverPort
      || p.database !== target.database || p.user !== target.role) {
      return deny('connexion PostgreSQL non autorisée')();
    }
    return originalPgConnect.apply(this, args);
  });
  databaseAllowed = allowDatabase;
}

module.exports = { installExternalGuards, assertExternalGuards };
