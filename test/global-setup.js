'use strict';

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const { Client } = require('pg');
const { getTestDatabaseUrl, assertTestDatabaseIsolation } = require('../config/testDatabase');
const { loadTargets, verifyConnection } = require('../config/migrationSafety');

module.exports = async () => {
  const root = path.resolve(__dirname, '..');
  const envFile = path.join(root, '.env.test');
  if (!fs.existsSync(envFile)) throw new Error('Configuration .env.test obligatoire ; aucun fallback application.');
  const values = dotenv.parse(fs.readFileSync(envFile));
  for (const key of ['DATABASE_TEST_URL', 'DATABASE_TEST_NAME', 'DATABASE_URL', 'NODE_ENV']) {
    if (values[key] !== undefined && process.env[key] !== undefined && values[key] !== process.env[key]) {
      throw new Error(`Configuration test contradictoire : ${key}`);
    }
  }
  const env = { ...values, ...process.env };
  const dbUrl = getTestDatabaseUrl(env);
  await assertTestDatabaseIsolation(dbUrl);
  const url = new URL(dbUrl);
  const target = loadTargets().test.find(candidate =>
    candidate.host === url.hostname && candidate.database === decodeURIComponent(url.pathname.slice(1))
    && candidate.role === decodeURIComponent(url.username));
  const client = new Client({ connectionString: dbUrl, connectionTimeoutMillis: 10000 });
  try {
    await client.connect();
    await verifyConnection(client, target);
    await client.query('BEGIN READ ONLY');
    const { rows } = await client.query('SELECT name FROM "SequelizeMeta"');
    const applied = new Set(rows.map(row => row.name));
    const required = fs.readdirSync(path.join(root, 'migrations')).filter(name => /\.(js|cjs)$/.test(name));
    const missing = required.filter(name => !applied.has(name));
    if (missing.length) throw new Error(`Schéma test non préparé : ${missing.join(', ')}. Aucune migration automatique.`);
    await client.query('COMMIT');
  } finally {
    await client.end();
  }
  Object.assign(process.env, values, {
    DATABASE_URL: dbUrl, DATABASE_TEST_URL: dbUrl, NODE_ENV: 'test',
  });
  console.log('[global-setup] Identité et migrations déjà appliquées vérifiées en lecture seule. Aucune migration exécutée.');
};
