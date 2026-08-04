#!/usr/bin/env node
'use strict';
/**
 * migrate-settings-encrypt.js
 *
 * Chiffre smtpPassword et slackWebhook stockés en clair dans system_settings.data (JSONB).
 *
 * Utilisation :
 *   node scripts/migrate-settings-encrypt.js           → dry-run (aucune écriture)
 *   node scripts/migrate-settings-encrypt.js --execute  → applique les modifications
 *
 * Prérequis :
 *   SETTINGS_ENCRYPTION_KEY définie dans .env (ou l'environnement).
 */

require('dotenv').config();

const { Sequelize, DataTypes } = require('sequelize');
const { encryptSecret, isEncrypted } = require('../src/utils/settingsCrypto');

const DRY_RUN    = !process.argv.includes('--execute');
const SECRET_FIELDS = ['smtpPassword', 'slackWebhook'];

async function main() {
  if (DRY_RUN) {
    console.log('═══════════════════════════════════════════════════════');
    console.log('  DRY-RUN — aucune écriture en base de données');
    console.log('  Pour appliquer : ajouter --execute');
    console.log('═══════════════════════════════════════════════════════\n');
  } else {
    console.log('⚠️  MODE EXÉCUTION — les secrets vont être chiffrés\n');
  }

  // Valider la clé avant toute opération DB
  try {
    encryptSecret('test-validation');
  } catch (e) {
    console.error('ERREUR clé : ' + e.message);
    process.exit(1);
  }

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) { console.error('DATABASE_URL manquante'); process.exit(1); }

  const sequelize = new Sequelize(dbUrl, { logging: false });

  const SystemSetting = sequelize.define('SystemSetting', {
    id:   { type: DataTypes.UUID, primaryKey: true },
    key:  { type: DataTypes.STRING },
    data: { type: DataTypes.JSONB },
  }, { tableName: 'system_settings', underscored: true, timestamps: false });

  await sequelize.authenticate();
  console.log('Connexion DB OK\n');

  const rows = await SystemSetting.findAll();

  if (rows.length === 0) {
    console.log('ℹ️  Table system_settings vide — aucune migration nécessaire.');
    await sequelize.close();
    return;
  }

  console.log(`${rows.length} ligne(s) trouvée(s) dans system_settings.\n`);
  console.log('── Inventaire des secrets ──────────────────────────────');

  let toMigrate = 0;

  for (const row of rows) {
    const data = row.data || {};
    console.log(`\n  Clé : "${row.key}"`);

    for (const field of SECRET_FIELDS) {
      const val = data[field];

      if (!val || val === '') {
        console.log(`    ${field.padEnd(16)} : <vide> — ignoré`);
      } else if (isEncrypted(val)) {
        console.log(`    ${field.padEnd(16)} : déjà chiffré ✓`);
      } else {
        const preview = val.length > 4 ? val.slice(0, 4) + '…' : '****';
        const encrypted = encryptSecret(val);
        console.log(`    ${field.padEnd(16)} : EN CLAIR (${val.length} chars, début="${preview}") → serait chiffré (${encrypted.length} chars)`);
        toMigrate++;
      }
    }
  }

  console.log('\n────────────────────────────────────────────────────────');
  console.log(`  Champs à migrer : ${toMigrate}`);
  console.log('────────────────────────────────────────────────────────\n');

  if (toMigrate === 0) {
    console.log('✅ Tous les secrets sont déjà chiffrés.');
    await sequelize.close();
    return;
  }

  if (DRY_RUN) {
    console.log('Dry-run terminé. Aucune modification apportée.');
    console.log('Pour appliquer : node scripts/migrate-settings-encrypt.js --execute');
  } else {
    let ok = 0, ko = 0;
    for (const row of rows) {
      const data = { ...row.data };
      let changed = false;

      for (const field of SECRET_FIELDS) {
        if (data[field] && !isEncrypted(data[field])) {
          data[field] = encryptSecret(data[field]);
          changed = true;
        }
      }

      if (changed) {
        try {
          await SystemSetting.update({ data }, { where: { id: row.id } });
          console.log(`  ✅ Clé "${row.key}" migrée`);
          ok++;
        } catch (e) {
          console.error(`  ✗ Clé "${row.key}" : ${e.message}`);
          ko++;
        }
      }
    }
    console.log(`\nMigration terminée : ${ok} ligne(s) ok, ${ko} erreur(s).`);
  }

  await sequelize.close();
}

main().catch(e => { console.error('Erreur inattendue :', e.message); process.exit(1); });
