'use strict';

jest.mock('pg', () => ({ Client: jest.fn() }));
jest.mock('child_process', () => ({ spawnSync: jest.fn() }));
jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  existsSync: jest.fn(jest.requireActual('fs').existsSync),
  readFileSync: jest.fn(jest.requireActual('fs').readFileSync),
}));

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { spawnSync } = require('child_process');
const safety = require('../../config/migrationSafety');
const { main } = require('../../scripts/migrations');
const testDatabase = require('../../config/testDatabase');
const actualFs = jest.requireActual('fs');
const originalEnv = process.env;
const originalArgv = process.argv;
const url = 'postgresql://test_migrator:fake-password@localhost:5432/teamoff_test';
const target = {
  host: 'localhost', database: 'teamoff_test', databaseOid: '12000', cluster: '1234567890123456789',
  serverAddress: '127.0.0.1', serverPort: '5432', role: 'test_migrator',
};
let targets, values, exists, connection;

function fakeConnection(identity = { ...target, sessionRole: target.role }) {
  return {
    connect: jest.fn().mockResolvedValue(undefined),
    end: jest.fn().mockResolvedValue(undefined),
    query: jest.fn(async sql => {
      if (['BEGIN READ ONLY', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [] };
      if (sql.includes('pg_control_system')) return { rows: [identity] };
      if (sql === 'SELECT name FROM "SequelizeMeta"') {
        return { rows: actualFs.readdirSync(path.join(safety.root, 'migrations')).map(name => ({ name })) };
      }
      throw new Error('Test simulé : toute requête non prévue est interdite.');
    }),
  };
}

beforeEach(() => {
  process.env = { NODE_ENV: 'test' };
  process.argv = ['node', 'sequelize', 'db:migrate', '--env', 'test'];
  targets = { development: [], test: [{ ...target }], production: [] };
  values = { MIGRATION_DATABASE_URL: url, MIGRATION_SSL: 'disable', NODE_ENV: 'test' };
  exists = true;
  connection = fakeConnection();
  Client.mockImplementation(() => connection);
  spawnSync.mockReturnValue({ status: 0 });
  fs.existsSync.mockImplementation(filename =>
    String(filename).includes('.env.migrations.') ? exists : actualFs.existsSync(filename));
  fs.readFileSync.mockImplementation((filename, ...args) => {
    if (String(filename).endsWith('migrationTargets.json')) return JSON.stringify(targets);
    if (String(filename).includes('.env.migrations.')) {
      return Buffer.from(Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n'));
    }
    if (String(filename).endsWith('/.env.test')) {
      return Buffer.from(`NODE_ENV=test\nDATABASE_TEST_URL=${url}\n`);
    }
    return actualFs.readFileSync(filename, ...args);
  });
});

afterEach(() => {
  process.env = originalEnv;
  process.argv = originalArgv;
});

test.each(['', undefined, 'staging', 'prod', 'Test'])('environnement inconnu %s refusé sans connexion ni CLI', async environment => {
  await expect(main(['apply', environment])).rejects.toThrow(/Environnement/);
  expect(Client).not.toHaveBeenCalled();
  expect(spawnSync).not.toHaveBeenCalled();
});

test.each([
  [], ['blocked'], ['undo', 'test'], ['apply'], ['apply', 'test', '--url', url],
  ['apply', 'test', '--config', 'config/config.json'], ['apply', 'test', '--options-path', 'other.json'],
].map(args => [args]))('arguments génériques, rollback et substitution refusés : %j', async args => {
  await expect(main(args)).rejects.toThrow(/bloqué/);
  expect(Client).not.toHaveBeenCalled();
  expect(spawnSync).not.toHaveBeenCalled();
});

test('configuration dédiée obligatoire, aucun fallback .env ou shell', async () => {
  exists = false;
  process.env.MIGRATION_DATABASE_URL = url;
  await expect(main(['apply', 'test'])).rejects.toThrow(/absente/);
  expect(Client).not.toHaveBeenCalled();
  expect(spawnSync).not.toHaveBeenCalled();
});

test.each([
  ['NODE_ENV', 'production'],
  ['DATABASE_URL', 'postgresql://admin:fake@localhost/teamoff'],
  ['DATABASE_TEST_URL', 'postgresql://admin:fake@localhost/teamoff'],
  ['DATABASE_TEST_NAME', 'teamoff'],
  ['MIGRATION_DATABASE_URL', 'postgresql://admin:fake@localhost/teamoff'],
  ['MIGRATION_SSL', 'require'],
  ['PGHOST', 'other-server'],
  ['PGOPTIONS', '-c role=admin'],
  ['NODE_OPTIONS', '--require arbitrary.js'],
])('variable héritée contradictoire %s refusée avant tout lancement', async (key, value) => {
  process.env[key] = value;
  await expect(main(['apply', 'test'])).rejects.toThrow();
  expect(Client).not.toHaveBeenCalled();
  expect(spawnSync).not.toHaveBeenCalled();
});

test.each([
  '', 'not-a-url', 'mysql://user:fake@localhost/teamoff_test',
  'postgresql://user:fake@localhost/teamoff_test?host=other',
  'postgresql://user:fake@localhost/teamoff_test#fragment',
  'postgresql://localhost/teamoff_test', 'postgresql://user:fake@localhost/',
  'postgresql://user:fake@localhost/%invalid',
])('URL invalide ou paramètres de substitution refusés : %s', async value => {
  values.MIGRATION_DATABASE_URL = value;
  await expect(main(['apply', 'test'])).rejects.toThrow();
  expect(spawnSync).not.toHaveBeenCalled();
});

test.each(['NODE_ENV', 'MIGRATION_DATABASE_URL', 'MIGRATION_SSL'])('configuration manquante %s : contrat explicite', async key => {
  delete values[key];
  if (key === 'NODE_ENV') {
    // The environment is selected explicitly by the command, not inferred from this optional declaration.
    expect(safety.loadMigrationConfig('test').environment).toBe('test');
  } else {
    await expect(main(['apply', 'test'])).rejects.toThrow();
    expect(spawnSync).not.toHaveBeenCalled();
  }
});

test('variable inconnue ou environnement du fichier contradictoire refusés', () => {
  values.DATABASE_URL = url;
  expect(() => safety.loadMigrationConfig('test')).toThrow(/inconnue/);
  delete values.DATABASE_URL;
  values.NODE_ENV = 'production';
  expect(() => safety.loadMigrationConfig('test')).toThrow(/contredit/);
});

test('aucune cible, cible incomplète et même base approuvée dans deux environnements refusées', () => {
  targets.test = [];
  expect(() => safety.loadMigrationConfig('test')).toThrow(/non autorisée/);
  targets.test = [{ ...target, cluster: '' }];
  expect(() => safety.loadTargets()).toThrow(/incomplète/);
  targets.test = [{ ...target }];
  targets.production = [{ ...target }];
  expect(() => safety.loadTargets()).toThrow(/plusieurs/);
});

test('une URL brute de test vers la base partagée est refusée malgré une URL syntaxiquement valide', async () => {
  values.MIGRATION_DATABASE_URL = 'postgresql://test_migrator:fake-password@localhost:5432/teamoff';
  await expect(main(['apply', 'test'])).rejects.toThrow(/non autorisée/);
  expect(Client).not.toHaveBeenCalled();
  expect(spawnSync).not.toHaveBeenCalled();
});

test.each(['database', 'databaseOid', 'cluster', 'serverAddress', 'serverPort', 'role', 'sessionRole'])(
  'identité réelle %s incohérente : refus en lecture seule et zéro lancement CLI',
  async field => {
    connection = fakeConnection({ ...target, sessionRole: target.role, [field]: 'unexpected' });
    Client.mockImplementation(() => connection);
    await expect(main(['check', 'test'])).rejects.toThrow(/Identité PostgreSQL refusée/);
    expect(connection.query.mock.calls[0]).toEqual(['BEGIN READ ONLY']);
    expect(connection.query.mock.calls.at(-1)).toEqual(['ROLLBACK']);
    expect(connection.end).toHaveBeenCalledTimes(1);
    expect(spawnSync).not.toHaveBeenCalled();
  }
);

test('identité inaccessible : aucun fallback et connexion fermée', async () => {
  connection.query.mockImplementation(async sql => {
    if (sql === 'BEGIN READ ONLY' || sql === 'ROLLBACK') return { rows: [] };
    throw new Error('Accès pg_control_system refusé (simulé)');
  });
  await expect(main(['check', 'test'])).rejects.toThrow(/refusé/);
  expect(connection.end).toHaveBeenCalled();
  expect(spawnSync).not.toHaveBeenCalled();
});

test('check : identité autorisée simulée, lectures uniquement, aucun CLI', async () => {
  await main(['check', 'test']);
  expect(connection.query.mock.calls.at(-1)).toEqual(['COMMIT']);
  expect(Client.mock.calls[0][0]).toMatchObject({ connectionString: url, ssl: false });
  expect(spawnSync).not.toHaveBeenCalled();
});

test('apply autorisé transmet uniquement les arguments canoniques à un exécuteur simulé', async () => {
  await main(['apply', 'test']);
  expect(Client).not.toHaveBeenCalled();
  expect(spawnSync).toHaveBeenCalledWith(process.execPath, [
    require.resolve('sequelize-cli/lib/sequelize'), 'db:migrate', '--env', 'test',
  ], expect.objectContaining({
    cwd: safety.root, env: expect.objectContaining({ NODE_ENV: 'test', TEAMOFF_MIGRATION_ENTRY: 'guarded' }),
  }));
});

test('échec de l’exécuteur simulé est signalé explicitement', async () => {
  spawnSync.mockReturnValue({ status: 1 });
  await expect(main(['apply', 'test'])).rejects.toThrow(/refusée ou échouée/);
});

test.each([
  ['db:migrate'], ['db:migrate', '--env', 'test', '--url', url],
  ['db:migrate:undo', '--env', 'test'], ['db:migrate:undo:all', '--env', 'test'],
  ['db:seed:all', '--env', 'test'], ['db:drop', '--env', 'test'],
  ['db:migrate', '--env', 'test', '--config', 'config/config.json'],
].map(args => [args]))('CLI non canonique bloqué : %j', args => {
  expect(() => safety.assertCliInvocation(['node', 'sequelize', ...args], {
    TEAMOFF_MIGRATION_ENTRY: 'guarded', NODE_ENV: 'test',
  })).toThrow(/bloqués/);
});

test('CLI direct sans provenance refusé même avec environnement correct', () => {
  expect(() => safety.assertCliInvocation()).toThrow(/CLI direct/);
  process.env.TEAMOFF_MIGRATION_ENTRY = 'guarded';
  expect(safety.assertCliInvocation()).toBe('test');
});

test('production ne charge pas la configuration test et exige TLS vérifié', () => {
  process.env.NODE_ENV = 'production';
  values.NODE_ENV = 'production';
  targets.test = [];
  targets.production = [{ ...target }];
  expect(() => safety.loadMigrationConfig('production')).toThrow(/TLS/);
  values.MIGRATION_SSL = 'require';
  expect(safety.loadMigrationConfig('production').ssl).toEqual({ rejectUnauthorized: true });
  expect(fs.readFileSync.mock.calls.some(([f]) => String(f).endsWith('.env.migrations.production'))).toBe(true);
  expect(fs.readFileSync.mock.calls.some(([f]) => String(f).endsWith('/.env.test'))).toBe(false);
});

test.each(['database', 'databaseOid', 'cluster', 'serverAddress', 'serverPort', 'role', 'sessionRole'])(
  'la connexion réelle du gestionnaire Sequelize refuse une divergence %s (transport simulé)',
  async field => {
    process.env.TEAMOFF_MIGRATION_ENTRY = 'guarded';
    let config;
    jest.isolateModules(() => { config = require('../../config/config').test; });
    const { Sequelize } = require('sequelize');
    const sequelize = new Sequelize({ ...config, pool: { min: 0 } });
    const connect = jest.spyOn(sequelize.dialect.connectionManager, 'connect');
    connect.mockResolvedValue(connection);
    await expect(sequelize.connectionManager._connect(sequelize.connectionManager.config)).resolves.toBe(connection);
    const wrong = fakeConnection({ ...target, sessionRole: target.role, [field]: 'unexpected' });
    connect.mockResolvedValue(wrong);
    await expect(sequelize.connectionManager._connect(sequelize.connectionManager.config)).rejects.toThrow(/Identité/);
    expect(wrong.end).toHaveBeenCalledTimes(1);
    expect(wrong.query.mock.calls.every(([sql]) =>
      ['BEGIN READ ONLY', 'ROLLBACK'].includes(sql) || sql.includes('pg_control_system'))).toBe(true);
    expect(spawnSync).not.toHaveBeenCalled();
    connect.mockRestore();
    await sequelize.close();
  }
);

test('les anciens fichiers CLI ne fournissent aucune configuration alternative utilisable', () => {
  expect(JSON.parse(actualFs.readFileSync(path.join(safety.root, 'config/config.json')))).toEqual({});
  expect(() => {
    jest.isolateModules(() => require('../../.sequelizerc'));
  }).toThrow(/CLI direct/);
  expect(() => {
    jest.isolateModules(() => require('../../config/config'));
  }).toThrow(/CLI direct/);
  expect(Client).not.toHaveBeenCalled();
});

test('le nom de base test ne remplace plus silencieusement une URL vers teamoff', () => {
  expect(() => testDatabase.getTestDatabaseUrl({
    NODE_ENV: 'test', DATABASE_TEST_URL: 'postgresql://admin:fake@localhost/teamoff',
    DATABASE_TEST_NAME: 'teamoff_notifications_test',
  })).toThrow(/ne peut plus remplacer/);
  expect(() => testDatabase.getTestDatabaseUrl({ NODE_ENV: 'test', DATABASE_URL: url })).toThrow(/URL/);
});

test('garde test : une cible non autorisée ne provoque aucune connexion', async () => {
  await expect(testDatabase.assertTestDatabaseIsolation('postgresql://admin:fake@localhost/teamoff'))
    .rejects.toThrow(/non autorisée/);
  expect(Client).not.toHaveBeenCalled();
});

test('setup métier vérifie seulement l’identité et SequelizeMeta, sans migrateur ni modèle', async () => {
  await require('../global-setup')();
  expect(Client).toHaveBeenCalledTimes(2);
  expect(connection.query.mock.calls.some(([sql]) => sql === 'SELECT name FROM "SequelizeMeta"')).toBe(true);
  expect(connection.query.mock.calls.every(([sql]) =>
    ['BEGIN READ ONLY', 'COMMIT', 'ROLLBACK', 'SELECT name FROM "SequelizeMeta"'].includes(sql)
    || sql.includes('pg_control_system'))).toBe(true);
  expect(spawnSync).not.toHaveBeenCalled();
  expect(process.env.DATABASE_URL).toBe(url);
});

test('setup refuse un schéma incomplet au lieu de lancer une migration', async () => {
  const original = connection.query.getMockImplementation();
  connection.query.mockImplementation(sql => sql === 'SELECT name FROM "SequelizeMeta"'
    ? Promise.resolve({ rows: [] }) : original(sql));
  await expect(require('../global-setup')()).rejects.toThrow(/Aucune migration automatique/);
  expect(spawnSync).not.toHaveBeenCalled();
  expect(connection.end).toHaveBeenCalled();
});

test('setup refuse un fichier test absent ou des variables héritées contradictoires sans connexion', async () => {
  fs.existsSync.mockImplementation(filename =>
    String(filename).endsWith('/.env.test') ? false : actualFs.existsSync(filename));
  await expect(require('../global-setup')()).rejects.toThrow(/aucun fallback/);
  expect(Client).not.toHaveBeenCalled();
  fs.existsSync.mockImplementation(actualFs.existsSync);
  process.env.DATABASE_TEST_URL = 'postgresql://admin:fake@localhost/teamoff';
  await expect(require('../global-setup')()).rejects.toThrow(/contradictoire/);
  expect(Client).not.toHaveBeenCalled();
});

test.each(['development', 'test', 'production'])('source distincte pour %s, sans lecture du fichier applicatif', environment => {
  process.env.NODE_ENV = environment;
  values.NODE_ENV = environment;
  values.MIGRATION_SSL = environment === 'production' ? 'require' : 'disable';
  targets = { development: [], test: [], production: [], [environment]: [{ ...target }] };
  expect(safety.loadMigrationConfig(environment).environment).toBe(environment);
  const files = fs.readFileSync.mock.calls.map(([file]) => String(file));
  expect(files.some(file => file.endsWith(`.env.migrations.${environment}`))).toBe(true);
  expect(files.some(file => file.endsWith('/.env') || file.endsWith('/.env.test'))).toBe(false);
});

test('vérification de déploiement locale uniquement, contradictions refusées', () => {
  const check = require('../../scripts/check-deploy-environment').check;
  const read = fs.readFileSync.getMockImplementation();
  fs.readFileSync.mockImplementation((filename, ...args) => String(filename).endsWith('/.env')
    ? Buffer.from(`NODE_ENV=development\nDATABASE_URL=${url}`) : read(filename, ...args));
  expect(() => check('production', {})).toThrow(/contredit/);
  expect(() => check('staging', {})).toThrow(/non autorisé/);
  expect(() => check('development', { DATABASE_URL: 'postgresql://admin:fake@other/teamoff' }))
    .toThrow(/contradictoires/);
  expect(() => check('development', {})).not.toThrow();
  expect(Client).not.toHaveBeenCalled();
  expect(spawnSync).not.toHaveBeenCalled();
});

test('déploiement et sync ne contiennent plus d’exécution implicite de migration ou de schéma', () => {
  const deploy = actualFs.readFileSync(path.join(safety.root, '..', 'deploy.sh'), 'utf8');
  expect(deploy).not.toMatch(/npm run migrate|sequelize-cli|cp "\$BACKEND_DIR\/\.env/);
  const sync = actualFs.readFileSync(path.join(safety.root, 'sync-db.js'), 'utf8');
  expect(sync).not.toMatch(/require\(|sequelize\.sync/);
  const pkg = JSON.parse(actualFs.readFileSync(path.join(safety.root, 'package.json')));
  expect(pkg.dependencies['sequelize-cli']).toBe('6.6.5');
  for (const key of ['migrate', 'migrate:status', 'migrate:undo', 'predeploy']) {
    expect(pkg.scripts[key]).toBe('node scripts/migrations.js blocked');
  }
});
