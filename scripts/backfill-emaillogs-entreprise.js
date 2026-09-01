'use strict';

/**
 * Backfill entreprise_id sur les email_logs existants où entreprise_id IS NULL.
 *
 * Résolution par priorité :
 *   1. utilisateur_id  → Utilisateur.entreprise_id
 *   2. to_address      → Utilisateur.email → entreprise_id
 *
 * Usage :
 *   node scripts/backfill-emaillogs-entreprise.js          # simulation (--dry-run)
 *   node scripts/backfill-emaillogs-entreprise.js --apply  # applique les mises à jour
 */

require('dotenv').config();
const { sequelize, EmailLog, Utilisateur } = require('../src/models');

const APPLY = process.argv.includes('--apply');
const BATCH = 200;

async function run() {
  console.log(`Mode : ${APPLY ? 'APPLY' : 'DRY-RUN (--apply pour appliquer)'}\n`);

  const total = await EmailLog.count({ where: { entreprise_id: null } });
  console.log(`Logs email avec entreprise_id = NULL : ${total}`);
  if (total === 0) { console.log('Rien à faire.'); return; }

  // Précache : utilisateur_id → entreprise_id
  const userIdCache  = new Map(); // utilisateur_id → entreprise_id
  const emailCache   = new Map(); // to_address    → entreprise_id

  let offset  = 0;
  let updated = 0;
  let skipped = 0;

  while (offset < total) {
    const batch = await EmailLog.findAll({
      where: { entreprise_id: null },
      attributes: ['id', 'utilisateur_id', 'to_address'],
      limit: BATCH,
      offset,
      raw: true,
    });

    if (batch.length === 0) break;

    for (const log of batch) {
      let entrepriseId = null;

      // 1. via utilisateur_id
      if (log.utilisateur_id) {
        if (!userIdCache.has(log.utilisateur_id)) {
          const u = await Utilisateur.findByPk(log.utilisateur_id, { attributes: ['entreprise_id'] });
          userIdCache.set(log.utilisateur_id, u?.entreprise_id || null);
        }
        entrepriseId = userIdCache.get(log.utilisateur_id);
      }

      // 2. fallback via to_address
      if (!entrepriseId && log.to_address) {
        const addr = log.to_address.toLowerCase().trim();
        if (!emailCache.has(addr)) {
          const u = await Utilisateur.findOne({ where: { email: addr }, attributes: ['entreprise_id'] });
          emailCache.set(addr, u?.entreprise_id || null);
        }
        entrepriseId = emailCache.get(addr);
      }

      if (!entrepriseId) { skipped++; continue; }

      if (APPLY) {
        await EmailLog.update({ entreprise_id: entrepriseId }, { where: { id: log.id } });
      }
      updated++;
    }

    offset += batch.length;
    process.stdout.write(`\r  Traités : ${offset}/${total} — à mettre à jour : ${updated} — sans résolution : ${skipped}`);
  }

  console.log(`\n\nRésultat :`);
  console.log(`  Logs résolus  : ${updated}`);
  console.log(`  Non résolus   : ${skipped}`);
  if (!APPLY && updated > 0) console.log(`\nRelancez avec --apply pour appliquer.`);
  if (APPLY) console.log(`\nMise à jour appliquée.`);
}

run()
  .catch((err) => { console.error(err); process.exit(1); })
  .finally(() => sequelize.close());
