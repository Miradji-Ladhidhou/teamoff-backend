'use strict';

const { Client } = require('pg');
const safety = require('./migrationSafety');

function getTestDatabaseUrl(env = process.env) {
  safety.assertEnvironment('test', env);
  const url = safety.parseDatabaseUrl(env.DATABASE_TEST_URL);
  if (env.DATABASE_TEST_NAME && env.DATABASE_TEST_NAME !== decodeURIComponent(url.pathname.slice(1))) {
    throw new Error('DATABASE_TEST_NAME ne peut plus remplacer la base de DATABASE_TEST_URL. Corrigez l’URL explicitement.');
  }
  if (env.DATABASE_URL && env.DATABASE_URL !== env.DATABASE_TEST_URL) {
    throw new Error('DATABASE_URL héritée contredit DATABASE_TEST_URL ; tests refusés.');
  }
  if (Object.keys(env).some(key => key.startsWith('PG') && env[key])) {
    throw new Error('Substitutions PG* interdites pour la base de test.');
  }
  return url.toString();
}

async function assertTestDatabaseIsolation(testUrl) {
  const url = safety.parseDatabaseUrl(testUrl);
  const target = safety.loadTargets().test.find(candidate =>
    candidate.host === url.hostname && candidate.database === decodeURIComponent(url.pathname.slice(1))
    && candidate.role === decodeURIComponent(url.username));
  if (!target) throw new Error('Base de test non autorisée ; aucune connexion ni migration lancée.');
  const client = new Client({
    connectionString: testUrl, connectionTimeoutMillis: 10000,
  });
  try {
    await client.connect();
    return await safety.verifyConnection(client, target);
  } finally {
    await client.end();
  }
}

module.exports = { getTestDatabaseUrl, assertTestDatabaseIsolation };
