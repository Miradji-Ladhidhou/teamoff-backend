const { spawnSync } = require('child_process');

const steps = [
  { name: 'verify:conges-core', command: 'npm', args: ['run', 'verify:conges-core'] },
  { name: 'verify:conges-approval', command: 'npm', args: ['run', 'verify:conges-approval'] },
];

function runStep(step) {
  console.log(`\n=== Lancement ${step.name} ===`);

  const result = spawnSync(step.command, step.args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  const status = typeof result.status === 'number' ? result.status : 1;
  console.log(`=== Fin ${step.name} (code: ${status}) ===`);

  return {
    name: step.name,
    ok: status === 0,
    code: status,
  };
}

(function main() {
  const results = steps.map(runStep);
  const failed = results.filter((item) => !item.ok);

  console.log('\n=== Résumé vérification congés ===');
  results.forEach((item) => {
    console.log(`- ${item.name}: ${item.ok ? 'OK' : 'ECHEC'} (code ${item.code})`);
  });

  if (failed.length > 0) {
    process.exit(1);
  }

  process.exit(0);
})();
