'use strict';

jest.mock('../../src/config/database', () => ({
  transaction: jest.fn(), query: jest.fn(), close: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../src/services/startupSchemaService', () => ({ verifyStartupSchema: jest.fn() }));
const fs = require('fs');
const path = require('path');
const db = require('../../src/config/database');
const { verifyStartupSchema } = require('../../src/services/startupSchemaService');
const { checkDeployedSchema } = require('../../scripts/check-deployed-schema');
let environment;
let applied;

beforeEach(() => {
  environment = jest.replaceProperty(process, 'env', { NODE_ENV: 'production' });
  applied = fs.readdirSync(path.join(__dirname, '../../migrations'))
    .filter(name => name.endsWith('.js')).map(name => ({ name }));
  db.transaction.mockImplementation(async (options, callback) => callback('read-only-transaction'));
  db.query.mockImplementation(async (sql, options) => {
    expect(options.transaction).toBe('read-only-transaction');
    if (sql === 'SET TRANSACTION READ ONLY') return [];
    expect(sql.trim()).toMatch(/^SELECT /);
    if (sql.includes('SequelizeMeta')) return applied;
    if (sql.includes('pg_enum')) return [{ enumlabel: 'apprenti' }];
    return [];
  });
  verifyStartupSchema.mockImplementation(async connection => connection.query('SELECT 1', {}));
});
afterEach(() => environment.restore());

test('la commande historique vérifie seulement le schéma dans une transaction en lecture seule', async () => {
  await checkDeployedSchema([]);
  expect(db.transaction).toHaveBeenCalledWith({ readOnly: true }, expect.any(Function));
  expect(db.query.mock.calls[0][0]).toBe('SET TRANSACTION READ ONLY');
  expect(verifyStartupSchema).toHaveBeenCalled();
  expect(db.close).toHaveBeenCalledTimes(1);
});

test('une migration manquante bloque le build sans DDL', async () => {
  applied.pop();
  await expect(checkDeployedSchema([])).rejects.toThrow('Migrations manquantes');
  expect(db.query).toHaveBeenCalledTimes(2);
  expect(db.close).toHaveBeenCalledTimes(1);
});

test('un objet absent bloque même avec un historique complet', async () => {
  db.query.mockImplementation(async sql => {
    if (sql === 'SET TRANSACTION READ ONLY') return [];
    if (sql.includes('SequelizeMeta')) return applied;
    throw new Error('relation absente');
  });
  await expect(checkDeployedSchema([])).rejects.toThrow('relation absente');
  expect(db.close).toHaveBeenCalledTimes(1);
});

test('le rôle apprenti doit réellement exister', async () => {
  db.query.mockImplementation(async sql => sql.includes('SequelizeMeta') ? applied : []);
  await expect(checkDeployedSchema([])).rejects.toThrow('rôle apprenti absent');
});

test.each([['--url'], ['apply']])('les arguments supplémentaires sont refusés : %j', async argument => {
  await expect(checkDeployedSchema([argument])).rejects.toThrow('sans argument');
  expect(db.transaction).not.toHaveBeenCalled();
});

test('aucun environnement implicite', async () => {
  process.env.NODE_ENV = 'development';
  await expect(checkDeployedSchema([])).rejects.toThrow('production uniquement');
  expect(db.transaction).not.toHaveBeenCalled();
});
