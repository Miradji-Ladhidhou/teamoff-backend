// scripts/recalculateCountersProrata.js

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const { sequelize, Entreprise } = require('../src/models');
const { recalculateCountersProrata } = require('../src/services/quotasService');

function parseArgs(argv) {
  const args = {
    apply: false,
    year: new Date().getFullYear(),
    entrepriseId: null,
    onlyMissingHiringDate: false,
  };

  for (const raw of argv.slice(2)) {
    if (raw === '--apply') args.apply = true;
    if (raw === '--only-missing-hiring-date') args.onlyMissingHiringDate = true;
    if (raw.startsWith('--year=')) args.year = Number(raw.split('=')[1]);
    if (raw.startsWith('--entreprise=')) args.entrepriseId = raw.split('=')[1] || null;
  }

  if (!Number.isFinite(args.year) || args.year < 2000 || args.year > 2100) {
    throw new Error('Paramètre --year invalide (attendu: 2000..2100)');
  }

  return args;
}

function formatDelta(value) {
  const rounded = Number(value || 0);
  if (rounded > 0) return `+${rounded}`;
  return `${rounded}`;
}

async function run() {
  const args = parseArgs(process.argv);

  await sequelize.authenticate();
  console.log('Connexion DB OK');

  if (args.entrepriseId) {
    const entreprise = await Entreprise.findByPk(args.entrepriseId, { attributes: ['id', 'nom'] });
    if (!entreprise) throw new Error(`Entreprise introuvable: ${args.entrepriseId}`);
    console.log(`Entreprise ciblée: ${entreprise.nom} (${entreprise.id})`);
  }

  const result = await recalculateCountersProrata({
    annee: args.year,
    entrepriseId: args.entrepriseId,
    apply: args.apply,
    onlyMissingHiringDate: args.onlyMissingHiringDate,
    previewLimit: 20,
  });

  console.log(`Compteurs analysés: ${result.analyzed}`);
  if (result?.disabled) {
    console.log(`Mode: ${result.reason}`);
    console.log(result.message);
    return;
  }
  console.log(`Compteurs inchangés: ${result.unchanged}`);
  console.log(`Compteurs ignorés: ${result.skipped}`);
  console.log(`Compteurs à ajuster: ${result.to_adjust}`);

  if (Array.isArray(result.preview) && result.preview.length > 0) {
    console.log('--- Aperçu des ajustements (max 20) ---');
    result.preview.forEach((item) => {
      console.log([
        `counter=${item.counter_id}`,
        `user=${item.utilisateur_nom || item.utilisateur_id}`,
        `type=${item.conge_type_libelle || item.conge_type_id}`,
        `acquis:${item.jours_acquis_avant} -> ${item.jours_acquis_apres}`,
        `delta:${formatDelta(item.delta)}`,
      ].join(' | '));
    });
  }

  if (!args.apply) {
    console.log('Simulation terminée. Relance avec --apply pour enregistrer en base.');
    return;
  }

  console.log(`Ajustements appliqués: ${result.applied}`);
  console.log(`Delta total jours_acquis: ${formatDelta(result.total_delta)}`);
}

run()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Erreur recalcul prorata:', error);
    process.exit(1);
  });
