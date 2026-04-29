#!/usr/bin/env node
/**
 * check-db.js — vérifie que chaque modèle Sequelize correspond à la DB réelle.
 *
 * Vérifie :
 *  - colonnes manquantes (modèle → DB)
 *  - colonnes orphelines (DB → modèle)
 *  - types incohérents
 *  - nullabilité
 *  - timestamps (created_at, updated_at)
 *  - clés étrangères
 *  - index (présence)
 *
 * Usage : node scripts/check-db.js
 * Exit 0 = OK, Exit 1 = incohérences détectées
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { sequelize, ...models } = require('../src/models');

// ---------------------------------------------------------------------------
// Mapping Sequelize DataType → type(s) PostgreSQL attendu
// ---------------------------------------------------------------------------
const SEQUELIZE_TO_PG = {
  STRING:    ['character varying', 'varchar', 'text'],
  TEXT:      ['text', 'character varying'],
  INTEGER:   ['integer', 'int4', 'int'],
  BIGINT:    ['bigint', 'int8'],
  FLOAT:     ['double precision', 'float8', 'real', 'float4'],
  DOUBLE:    ['double precision', 'float8'],
  DECIMAL:   ['numeric', 'decimal'],
  BOOLEAN:   ['boolean'],
  UUID:      ['uuid'],
  DATE:      ['timestamp with time zone', 'timestamptz'],
  DATEONLY:  ['date'],
  JSONB:     ['jsonb'],
  JSON:      ['json', 'jsonb'],
  ENUM:      ['USER-DEFINED', 'character varying'], // PG stores ENUMs as USER-DEFINED
  ARRAY:     ['ARRAY'],
  VIRTUAL:   null, // skip — not stored in DB
};

// Colonnes gérées automatiquement par Sequelize — on les checke différemment
const SEQUELIZE_META_COLS = new Set(['created_at', 'updated_at', 'deleted_at']);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const RESET  = '\x1b[0m';
const RED    = '\x1b[31m';
const GREEN  = '\x1b[32m';
const YELLOW = '\x1b[33m';
const BOLD   = '\x1b[1m';
const DIM    = '\x1b[2m';

const ok   = (msg) => console.log(`  ${GREEN}✔${RESET}  ${msg}`);
const warn  = (msg) => console.log(`  ${YELLOW}⚠${RESET}  ${msg}`);
const err   = (msg) => console.log(`  ${RED}✖${RESET}  ${msg}`);
const title = (msg) => console.log(`\n${BOLD}${msg}${RESET}`);

// ---------------------------------------------------------------------------
// Fetch real DB schema for a table
// ---------------------------------------------------------------------------
async function getDbColumns(tableName) {
  const [rows] = await sequelize.query(
    `SELECT
       column_name,
       data_type,
       udt_name,
       is_nullable,
       column_default
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = :tableName
     ORDER BY ordinal_position`,
    { replacements: { tableName }, type: sequelize.QueryTypes.SELECT }
  );
  // sequelize.query returns [rows, meta] only when type is not specified;
  // with QueryTypes.SELECT it returns rows directly
  const results = Array.isArray(rows) ? rows : [rows].filter(Boolean);
  // When QueryTypes.SELECT is used, the result IS the array of rows
  return results;
}

async function getDbColumnsReal(tableName) {
  const results = await sequelize.query(
    `SELECT
       column_name,
       data_type,
       udt_name,
       is_nullable,
       column_default
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = $1
     ORDER BY ordinal_position`,
    {
      bind: [tableName],
      type: sequelize.QueryTypes.SELECT,
    }
  );
  return results;
}

// ---------------------------------------------------------------------------
// Fetch real indexes for a table
// ---------------------------------------------------------------------------
async function getDbIndexes(tableName) {
  return sequelize.query(
    `SELECT indexname, indexdef
     FROM pg_indexes
     WHERE schemaname = 'public'
       AND tablename  = $1`,
    { bind: [tableName], type: sequelize.QueryTypes.SELECT }
  );
}

// ---------------------------------------------------------------------------
// Fetch foreign keys for a table
// ---------------------------------------------------------------------------
async function getDbForeignKeys(tableName) {
  return sequelize.query(
    `SELECT
       kcu.column_name,
       ccu.table_name  AS foreign_table,
       ccu.column_name AS foreign_column
     FROM information_schema.table_constraints AS tc
     JOIN information_schema.key_column_usage AS kcu
       ON tc.constraint_name = kcu.constraint_name
      AND tc.table_schema    = kcu.table_schema
     JOIN information_schema.constraint_column_usage AS ccu
       ON ccu.constraint_name = tc.constraint_name
      AND ccu.table_schema    = tc.table_schema
     WHERE tc.constraint_type = 'FOREIGN KEY'
       AND tc.table_name      = $1
       AND tc.table_schema    = 'public'`,
    { bind: [tableName], type: sequelize.QueryTypes.SELECT }
  );
}

// ---------------------------------------------------------------------------
// Checks whether a DB type matches the expected Sequelize type
// ---------------------------------------------------------------------------
function typeMatches(seqTypeName, pgDataType, udtName) {
  const allowed = SEQUELIZE_TO_PG[seqTypeName.toUpperCase()];
  if (!allowed) return true; // unknown type — skip
  const pgLower = pgDataType.toLowerCase();
  const udtLower = (udtName || '').toLowerCase();
  return allowed.some(
    (a) => a.toLowerCase() === pgLower || a.toLowerCase() === udtLower
  );
}

// ---------------------------------------------------------------------------
// Check a single model
// ---------------------------------------------------------------------------
async function checkModel(modelName, model) {
  const tableName = model.getTableName();
  const displayName = typeof tableName === 'string' ? tableName : tableName.tableName;
  title(`[${modelName}]  table: ${DIM}${displayName}${RESET}`);

  // ---- 1. Check table exists ----
  const dbCols = await getDbColumnsReal(displayName);
  if (dbCols.length === 0) {
    err(`Table "${displayName}" introuvable dans la base.`);
    return { errors: 1, warnings: 0 };
  }

  const dbColMap = new Map(dbCols.map((c) => [c.column_name, c]));
  const attrs = model.rawAttributes;

  let errors = 0;
  let warnings = 0;

  // ---- 2. Model → DB ----
  for (const [attrName, attr] of Object.entries(attrs)) {
    const seqTypeName = attr.type?.constructor?.name || '';

    // Skip VIRTUAL fields — not stored
    if (seqTypeName === 'VIRTUAL') {
      ok(`${attrName}  ${DIM}(VIRTUAL — ignoré)${RESET}`);
      continue;
    }

    // Sequelize uses the field option (or the attrName) as column name
    const colName = attr.field || attrName;

    if (!dbColMap.has(colName)) {
      err(`Colonne manquante en DB : "${colName}" (attr: ${attrName}, type: ${seqTypeName})`);
      errors++;
      continue;
    }

    const dbCol = dbColMap.get(colName);

    // Type check
    if (!typeMatches(seqTypeName, dbCol.data_type, dbCol.udt_name)) {
      err(
        `Type incohérent "${colName}" : modèle=${seqTypeName.toUpperCase()}, ` +
        `DB=${dbCol.data_type}${dbCol.udt_name !== dbCol.data_type ? `(${dbCol.udt_name})` : ''}`
      );
      errors++;
    } else {
      ok(`${colName}  ${DIM}${seqTypeName} → ${dbCol.data_type}${RESET}`);
    }

    // Nullability check (only when model says NOT NULL)
    if (attr.allowNull === false && dbCol.is_nullable === 'YES') {
      warn(`Nullabilité : "${colName}" est NOT NULL dans le modèle mais NULLABLE en DB`);
      warnings++;
    }
  }

  // ---- 3. DB → Model (orphan columns) ----
  const modelColNames = new Set(
    Object.entries(attrs).map(([attrName, attr]) => attr.field || attrName)
  );

  for (const dbCol of dbCols) {
    if (!modelColNames.has(dbCol.column_name) && !SEQUELIZE_META_COLS.has(dbCol.column_name)) {
      warn(`Colonne DB orpheline (pas dans le modèle) : "${dbCol.column_name}" (${dbCol.data_type})`);
      warnings++;
    }
  }

  // ---- 4. Timestamps ----
  const hasCreatedAt = model.options?.createdAt;
  const hasUpdatedAt = model.options?.updatedAt;

  if (hasCreatedAt && hasCreatedAt !== false) {
    const tsCol = typeof hasCreatedAt === 'string' ? hasCreatedAt : 'created_at';
    if (!dbColMap.has(tsCol)) {
      err(`Timestamp manquant en DB : "${tsCol}" (createdAt)`);
      errors++;
    } else {
      ok(`${tsCol}  ${DIM}(timestamp createdAt)${RESET}`);
    }
  }

  if (hasUpdatedAt && hasUpdatedAt !== false) {
    const tsCol = typeof hasUpdatedAt === 'string' ? hasUpdatedAt : 'updated_at';
    if (!dbColMap.has(tsCol)) {
      err(`Timestamp manquant en DB : "${tsCol}" (updatedAt)`);
      errors++;
    } else {
      ok(`${tsCol}  ${DIM}(timestamp updatedAt)${RESET}`);
    }
  }

  // ---- 5. Foreign keys ----
  const dbFks = await getDbForeignKeys(displayName);
  const dbFkCols = new Set(dbFks.map((fk) => fk.column_name));

  for (const [attrName, attr] of Object.entries(attrs)) {
    if (!attr.references) continue;
    const colName = attr.field || attrName;
    if (!dbFkCols.has(colName)) {
      warn(
        `Clé étrangère absente en DB : "${colName}" → ${attr.references.model}.${attr.references.key || 'id'}`
      );
      warnings++;
    } else {
      ok(`FK ${colName}  ${DIM}→ ${attr.references.model}${RESET}`);
    }
  }

  // ---- 6. Indexes ----
  const dbIndexes = await getDbIndexes(displayName);
  const modelIndexes = model.options?.indexes || [];

  for (const idx of modelIndexes) {
    const fields = idx.fields || [];
    // Check that at least one real index covers these fields
    const covered = dbIndexes.some((dbIdx) =>
      fields.every((f) => dbIdx.indexdef.includes(`"${f}"`))
    );
    if (!covered) {
      warn(`Index manquant en DB pour [${fields.join(', ')}] sur "${displayName}"`);
      warnings++;
    } else {
      ok(`Index [${fields.join(', ')}]  ${DIM}présent${RESET}`);
    }
  }

  return { errors, warnings };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log(`\n${BOLD}╔══════════════════════════════════════════╗`);
  console.log(`║   check-db — Vérification DB ↔ Modèles   ║`);
  console.log(`╚══════════════════════════════════════════╝${RESET}`);

  try {
    await sequelize.authenticate();
    console.log(`\n${GREEN}Connexion DB : OK${RESET}`);
  } catch (e) {
    console.error(`${RED}Impossible de se connecter à la DB : ${e.message}${RESET}`);
    process.exit(1);
  }

  // Collect all Sequelize model objects (exclude non-model exports)
  const modelEntries = Object.entries(models).filter(
    ([, v]) => v && typeof v.getTableName === 'function'
  );

  if (modelEntries.length === 0) {
    console.error(`${RED}Aucun modèle trouvé dans src/models/index.js${RESET}`);
    process.exit(1);
  }

  let totalErrors = 0;
  let totalWarnings = 0;

  for (const [modelName, model] of modelEntries) {
    const { errors, warnings } = await checkModel(modelName, model);
    totalErrors += errors;
    totalWarnings += warnings;
  }

  // ---- Summary ----
  console.log(`\n${BOLD}╔══════════════════════════════╗`);
  console.log(`║         RÉSUMÉ FINAL         ║`);
  console.log(`╚══════════════════════════════╝${RESET}`);
  console.log(`  Modèles vérifiés : ${modelEntries.length}`);
  console.log(
    `  Erreurs  : ${totalErrors > 0 ? `${RED}${BOLD}${totalErrors}${RESET}` : `${GREEN}0${RESET}`}`
  );
  console.log(
    `  Warnings : ${totalWarnings > 0 ? `${YELLOW}${totalWarnings}${RESET}` : `${GREEN}0${RESET}`}`
  );

  if (totalErrors > 0) {
    console.log(`\n${RED}${BOLD}❌  Des incohérences critiques ont été détectées.${RESET}`);
    console.log(`${RED}   Corrigez-les avant tout déploiement.${RESET}\n`);
    await sequelize.close();
    process.exit(1);
  }

  if (totalWarnings > 0) {
    console.log(`\n${YELLOW}⚠   Warnings détectés — vérifiez avant de déployer.${RESET}\n`);
  } else {
    console.log(`\n${GREEN}${BOLD}✅  Tous les modèles correspondent à la base.${RESET}\n`);
  }

  await sequelize.close();
  process.exit(0);
}

main().catch((e) => {
  console.error(`${RED}Erreur inattendue : ${e.message}${RESET}`);
  console.error(e.stack);
  process.exit(1);
});
