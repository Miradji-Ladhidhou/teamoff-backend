'use strict';

/**
 * Backfill entreprise_id sur les audit_logs existants où entreprise_id IS NULL.
 *
 * Résolution par priorité :
 *   1. entity = 'user' | 'utilisateur' → Utilisateur.entreprise_id
 *   2. entity = 'conge'                → Conge.entreprise_id
 *   3. entity = 'entreprise'           → entity_id est l'entreprise elle-même
 *   4. Autres entités                  → user_id → Utilisateur.entreprise_id
 *
 * Usage :
 *   node scripts/backfill-audit-entreprise.js          # simulation (--dry-run)
 *   node scripts/backfill-audit-entreprise.js --apply  # applique les mises à jour
 */

require('dotenv').config();
const { sequelize, AuditLog, Utilisateur, Conge } = require('../src/models');
const { Op } = require('sequelize');

const APPLY = process.argv.includes('--apply');
const BATCH = 200;

async function resolveEntrepriseId(log, userCache, congeCache) {
  const { entity, entity_id, user_id } = log;

  // 1. entity = utilisateur / user
  if ((entity === 'user' || entity === 'utilisateur') && entity_id) {
    if (!userCache.has(entity_id)) {
      const u = await Utilisateur.findByPk(entity_id, { attributes: ['id', 'entreprise_id'] });
      userCache.set(entity_id, u?.entreprise_id || null);
    }
    if (userCache.get(entity_id)) return userCache.get(entity_id);
  }

  // 2. entity = conge
  if (entity === 'conge' && entity_id) {
    if (!congeCache.has(entity_id)) {
      const c = await Conge.findByPk(entity_id, { attributes: ['id', 'entreprise_id'] });
      congeCache.set(entity_id, c?.entreprise_id || null);
    }
    if (congeCache.get(entity_id)) return congeCache.get(entity_id);
  }

  // 3. entity = entreprise → entity_id IS the entreprise
  if (entity === 'entreprise' && entity_id) return entity_id;

  // 4. fallback : performer's entreprise via user_id
  if (user_id) {
    if (!userCache.has(user_id)) {
      const u = await Utilisateur.findByPk(user_id, { attributes: ['id', 'entreprise_id'] });
      userCache.set(user_id, u?.entreprise_id || null);
    }
    if (userCache.get(user_id)) return userCache.get(user_id);
  }

  return null;
}

async function run() {
  console.log(`Mode : ${APPLY ? 'APPLY' : 'DRY-RUN (--apply pour appliquer)'}\n`);

  const total = await AuditLog.count({ where: { entreprise_id: null } });
  console.log(`Logs avec entreprise_id = NULL : ${total}`);
  if (total === 0) { console.log('Rien à faire.'); return; }

  let offset = 0;
  let updated = 0;
  let skipped = 0;
  const userCache = new Map();
  const congeCache = new Map();

  while (offset < total) {
    const batch = await AuditLog.findAll({
      where: { entreprise_id: null },
      attributes: ['id', 'entity', 'entity_id', 'user_id'],
      limit: BATCH,
      offset,
      raw: true,
    });

    if (batch.length === 0) break;

    for (const log of batch) {
      const entrepriseId = await resolveEntrepriseId(log, userCache, congeCache);
      if (!entrepriseId) {
        skipped++;
        continue;
      }

      if (APPLY) {
        await AuditLog.update(
          { entreprise_id: entrepriseId },
          { where: { id: log.id } }
        );
      }
      updated++;
    }

    offset += batch.length;
    process.stdout.write(`\r  Traités : ${offset}/${total} — à mettre à jour : ${updated} — sans résolution : ${skipped}`);
  }

  console.log(`\n\nRésultat :`);
  console.log(`  Logs résolus  : ${updated}`);
  console.log(`  Non résolus   : ${skipped}`);
  if (!APPLY && updated > 0) {
    console.log(`\nRelancez avec --apply pour appliquer.`);
  }
  if (APPLY) {
    console.log(`\nMise à jour appliquée.`);
  }
}

run()
  .catch((err) => { console.error(err); process.exit(1); })
  .finally(() => sequelize.close());
