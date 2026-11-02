'use strict';

const { loadHarnessConfig, verifyPools, withHarnessImports } = require('../../config/integrationHarness');

let loadPromise;
let closePromise;
let pools;
let cleanupPromise;

function cleanupPools() {
  if (!cleanupPromise) cleanupPromise = (async () => {
    if (!pools) return;
    const results = await Promise.allSettled(Object.values(pools).map(pool => pool.close()));
    const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (errors.length) throw new AggregateError(errors, 'Fermeture des pools du harness incomplète.');
  })();
  return cleanupPromise;
}

function closeHarness() {
  if (!closePromise) closePromise = (async () => {
    // Drain initialization before closing pools; the loader owns startup errors.
    if (loadPromise) await loadPromise.then(() => undefined, () => undefined);
    await cleanupPools();
  })();
  return closePromise;
}

function loadHarnessApp() {
  if (closePromise) return Promise.reject(new Error('Harness fermé.'));
  if (!loadPromise) loadPromise = (async () => {
    loadHarnessConfig();
    require('./externalGuards').assertExternalGuards();
    if (process.env.TEAMOFF_HARNESS_ENABLE !== 'approved') {
      throw new Error('Harness réel non autorisé.');
    }
    try {
      withHarnessImports('pools', () => {
        pools = { models: require('../../src/models').sequelize };
        pools.queries = require('../../src/config/database');
      });
      const identities = await verifyPools(pools);
      if (closePromise) throw new Error('Harness fermé pendant la vérification.');
      const app = withHarnessImports('app', () => require('../../src/index'));
      return { app, pools, identities };
    } catch (error) {
      try { await cleanupPools(); } catch (cleanupError) { error.cleanupError = cleanupError; }
      throw error;
    }
  })();
  return loadPromise;
}

module.exports = { loadHarnessApp, closeHarness };
