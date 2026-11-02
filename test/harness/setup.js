'use strict';

const { loadHarnessConfig } = require('../../config/integrationHarness');

if (process.env.TEAMOFF_HARNESS_ENABLE !== 'approved') {
  throw new Error('Harness réel désactivé : une autorisation distincte est obligatoire.');
}
const config = loadHarnessConfig();
require('./externalGuards').installExternalGuards({ allowDatabase: true });
Object.assign(process.env, {
  DATABASE_URL: config.url,
  DATABASE_TEST_URL: config.url,
  DATABASE_TEST_NAME: config.target.database,
  JWT_SECRET: 'harness-only-jwt-secret-never-for-real-users',
  JWT_REFRESH_SECRET: 'harness-only-refresh-secret-never-for-real-users',
});

afterAll(async () => {
  const { closeHarness } = require('./app');
  await closeHarness();
});
