'use strict';

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const { Client } = require('pg');

const root = path.resolve(__dirname, '..');
const environments = ['development', 'test', 'production'];
const identityFields = ['database', 'databaseOid', 'cluster', 'serverAddress', 'serverPort', 'role'];
const targetFields = [...identityFields, 'host'];
const identitySQL = `
  SELECT pg_catalog.current_database() AS database,
    (SELECT oid::text FROM pg_catalog.pg_database WHERE datname = pg_catalog.current_database()) AS "databaseOid",
    (SELECT system_identifier::text FROM pg_catalog.pg_control_system()) AS cluster,
    pg_catalog.inet_server_addr()::text AS "serverAddress",
    pg_catalog.inet_server_port()::text AS "serverPort",
    current_user::text AS role, session_user::text AS "sessionRole"
`;

function assertEnvironment(environment, env = process.env) {
  if (!environments.includes(environment)) throw new Error('Environnement de migration explicite requis : development, test ou production.');
  if (env.NODE_ENV && env.NODE_ENV !== environment) throw new Error('NODE_ENV contredit l’environnement de migration demandé.');
}

function parseDatabaseUrl(value) {
  let url;
  try {
    url = new URL(value);
    decodeURIComponent(url.username);
    decodeURIComponent(url.password);
    decodeURIComponent(url.pathname);
  } catch {
    throw new Error('URL PostgreSQL manquante ou invalide.');
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname
    || !url.username || !url.pathname.slice(1) || url.search || url.hash
    || decodeURIComponent(url.pathname.slice(1)).includes('/')) {
    throw new Error('URL PostgreSQL explicite requise, sans paramètres de substitution.');
  }
  return url;
}

function loadTargets() {
  const targets = JSON.parse(fs.readFileSync(path.join(__dirname, 'migrationTargets.json'), 'utf8'));
  if (Object.keys(targets).some(key => !environments.includes(key))) throw new Error('Environnement inconnu dans les autorisations.');
  const assigned = new Set();
  for (const environment of environments) {
    if (!Array.isArray(targets[environment])) throw new Error('Liste de cibles autorisées manquante.');
    for (const target of targets[environment]) {
      if (Object.keys(target).some(key => !targetFields.includes(key))
        || targetFields.some(key => typeof target[key] !== 'string' || !target[key].trim())) {
        throw new Error('Autorisation de cible incomplète ou invalide.');
      }
      const key = `${target.cluster}:${target.databaseOid}`;
      if (assigned.has(key)) throw new Error('Une base ne peut être autorisée pour plusieurs environnements ou plusieurs cibles.');
      assigned.add(key);
    }
  }
  return targets;
}

function loadMigrationConfig(environment, env = process.env) {
  assertEnvironment(environment, env);
  if (env.NODE_OPTIONS || Object.keys(env).some(key => key.startsWith('PG') && env[key])) {
    throw new Error('NODE_OPTIONS et les substitutions PG* sont interdits pour les migrations.');
  }
  const filename = path.join(root, `.env.migrations.${environment}`);
  if (!fs.existsSync(filename)) throw new Error(`Configuration de migration dédiée absente : .env.migrations.${environment}`);
  const values = dotenv.parse(fs.readFileSync(filename));
  const allowed = ['MIGRATION_DATABASE_URL', 'MIGRATION_SSL', 'NODE_ENV'];
  if (Object.keys(values).some(key => !allowed.includes(key))) throw new Error('Variable inconnue dans la configuration de migration.');
  assertEnvironment(environment, values);
  for (const key of allowed) {
    if (env[key] !== undefined && values[key] !== undefined && env[key] !== values[key]) {
      throw new Error(`Variable héritée contradictoire : ${key}`);
    }
  }
  const url = parseDatabaseUrl(values.MIGRATION_DATABASE_URL);
  for (const key of ['DATABASE_URL', 'DATABASE_TEST_URL']) {
    if (env[key] && env[key] !== values.MIGRATION_DATABASE_URL) {
      throw new Error(`Variable applicative héritée contradictoire : ${key}`);
    }
  }
  if (env.DATABASE_TEST_NAME && env.DATABASE_TEST_NAME !== decodeURIComponent(url.pathname.slice(1))) {
    throw new Error('DATABASE_TEST_NAME contredit la cible de migration.');
  }
  if (!['require', 'disable'].includes(values.MIGRATION_SSL)
    || (environment === 'production' && values.MIGRATION_SSL !== 'require')) {
    throw new Error('MIGRATION_SSL doit être explicite ; TLS vérifié est obligatoire en production.');
  }
  const targets = loadTargets()[environment];
  const target = targets.find(candidate => candidate.host === url.hostname
    && candidate.database === decodeURIComponent(url.pathname.slice(1))
    && candidate.role === decodeURIComponent(url.username));
  if (!target) throw new Error('Cible de migration non autorisée pour cet environnement.');
  return {
    environment, url: values.MIGRATION_DATABASE_URL, target,
    ssl: values.MIGRATION_SSL === 'require' ? { rejectUnauthorized: true } : false,
  };
}

async function verifyConnection(connection, target) {
  await connection.query('BEGIN READ ONLY');
  try {
    const { rows } = await connection.query(identitySQL);
    const actual = rows[0];
    if (!actual || identityFields.some(key => actual[key] !== target[key])
      || actual.sessionRole !== target.role) {
      throw new Error('Identité PostgreSQL refusée : base, cluster, serveur ou rôle non autorisé.');
    }
    await connection.query('COMMIT');
    return actual;
  } catch (error) {
    await connection.query('ROLLBACK');
    throw error;
  }
}

async function checkTarget(config) {
  const client = new Client({ connectionString: config.url, ssl: config.ssl, connectionTimeoutMillis: 10000 });
  try {
    await client.connect();
    return await verifyConnection(client, config.target);
  } finally {
    await client.end();
  }
}

function assertCliInvocation(argv = process.argv, env = process.env) {
  const args = argv.slice(2);
  if (env.TEAMOFF_MIGRATION_ENTRY !== 'guarded'
    || args.length !== 3 || args[0] !== 'db:migrate' || args[1] !== '--env') {
    throw new Error('CLI direct et opérations génériques/rollback bloqués. Utilisez une commande migrate:<environnement>.');
  }
  assertEnvironment(args[2], env);
  return args[2];
}

module.exports = {
  root, environments, assertEnvironment, parseDatabaseUrl, loadTargets,
  loadMigrationConfig, verifyConnection, checkTarget, assertCliInvocation,
};
