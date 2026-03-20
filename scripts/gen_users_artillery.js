// Génère un fichier users_artillery.json avec 200 utilisateurs uniques et un conge_type_id valide
// Usage : node scripts/gen_users_artillery.js


const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { Sequelize, CongeType, Utilisateur, sequelize } = require('../src/models');

const OUTPUT = path.join(__dirname, '../users_artillery.jsonl');
const NB_USERS = 200;
const PASSWORD = 'Test@1234';

async function main() {
  await sequelize.authenticate();
  const congeType = await CongeType.findOne();
  if (!congeType) throw new Error('Aucun conge_type_id trouvé');
  const conge_type_id = congeType.id;

  const entrepriseIds = await Utilisateur.findAll({ attributes: ['entreprise_id'], group: ['entreprise_id'] });
  const entreprises = entrepriseIds.map(e => e.entreprise_id);
  if (!entreprises.length) throw new Error('Aucune entreprise trouvée');

  const lines = [];
  for (let i = 0; i < NB_USERS; i++) {
    const id = uuidv4();
    const email = `artillery_user_${i}_${Date.now()}@example.com`;
    const entreprise_id = entreprises[i % entreprises.length];
    const user = { id, email, password: PASSWORD, conge_type_id, entreprise_id };
    lines.push(JSON.stringify(user));
  }
  fs.writeFileSync(OUTPUT, lines.join('\n'));
  console.log(`Généré: ${OUTPUT} (${lines.length} users, format JSONL)`);
  await sequelize.close();
}

main().catch(e => { console.error(e); process.exit(1); });
