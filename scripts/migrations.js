'use strict';

const path = require('path');
const { spawnSync } = require('child_process');
const safety = require('../config/migrationSafety');

async function main(args = process.argv.slice(2)) {
  if (args.length !== 2 || !['check', 'apply'].includes(args[0])) {
    throw new Error('Commande générique ou rollback bloqué. Utilisez migrate:check:<environnement> ou migrate:<environnement>.');
  }
  const [action, environment] = args;
  const config = safety.loadMigrationConfig(environment);
  if (action === 'check') {
    const identity = await safety.checkTarget(config);
    console.log(`Cible vérifiée en lecture seule : ${environment} / ${identity.database}. Aucune migration exécutée.`);
    return;
  }
  const cli = require.resolve('sequelize-cli/lib/sequelize');
  const result = spawnSync(process.execPath, [cli, 'db:migrate', '--env', environment], {
    cwd: safety.root,
    env: { ...process.env, NODE_ENV: environment, TEAMOFF_MIGRATION_ENTRY: 'guarded' },
    stdio: 'inherit',
  });
  if (result.error) throw new Error('Impossible de lancer le CLI local sécurisé.');
  if (result.status !== 0) throw new Error('Migration refusée ou échouée ; consulter la sortie du CLI.');
}

if (require.main === module) {
  main().catch(error => {
    console.error(`[migration-safety] ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { main };
