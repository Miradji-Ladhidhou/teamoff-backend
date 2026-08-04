#!/usr/bin/env node
'use strict';
/**
 * migrate-totp-encrypt.js
 *
 * Chiffre les secrets TOTP stockés en clair dans la colonne totp_secret.
 *
 * Utilisation :
 *   node scripts/migrate-totp-encrypt.js           → dry-run (aucune écriture)
 *   node scripts/migrate-totp-encrypt.js --execute  → applique les modifications
 *
 * Prérequis :
 *   TOTP_ENCRYPTION_KEY doit être définie dans .env (ou l'environnement).
 *   La clé doit être identique en prod et après la migration.
 */

require('dotenv').config();

const { Sequelize, DataTypes } = require('sequelize');
const { encryptTotpSecret, isEncrypted } = require('../src/utils/totpCrypto');

const DRY_RUN = !process.argv.includes('--execute');

async function main() {
  if (DRY_RUN) {
    console.log('═══════════════════════════════════════════════════');
    console.log('  DRY-RUN — aucune écriture en base de données');
    console.log('  Pour appliquer : ajouter --execute');
    console.log('═══════════════════════════════════════════════════\n');
  } else {
    console.log('⚠️  MODE EXÉCUTION — les secrets vont être migrés\n');
  }

  // Valider la clé AVANT de toucher à la DB
  try {
    const { encryptTotpSecret: test } = require('../src/utils/totpCrypto');
    test('TESTSECRET'); // lance si clé absente/invalide
  } catch (e) {
    console.error('ERREUR : ' + e.message);
    process.exit(1);
  }

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error('DATABASE_URL manquante');
    process.exit(1);
  }

  const sequelize = new Sequelize(dbUrl, { logging: false });

  const Utilisateur = sequelize.define('Utilisateur', {
    id:           { type: DataTypes.UUID,    primaryKey: true },
    email:        { type: DataTypes.STRING },
    totp_secret:  { type: DataTypes.TEXT },
    totp_enabled: { type: DataTypes.BOOLEAN },
  }, { tableName: 'utilisateur', timestamps: false });

  try {
    await sequelize.authenticate();
    console.log('Connexion DB OK\n');
  } catch (e) {
    console.error('Connexion DB échouée :', e.message);
    process.exit(1);
  }

  // Vérifier que la colonne existe avant de requêter
  const [columns] = await sequelize.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = 'utilisateur' AND column_name IN ('totp_secret', 'totp_enabled');`
  );
  const colNames = columns.map(c => c.column_name);

  if (!colNames.includes('totp_secret') || !colNames.includes('totp_enabled')) {
    console.log('ℹ️  La colonne totp_secret/totp_enabled n\'existe pas encore en base.');
    console.log('   Aucune migration nécessaire — appliquer d\'abord les migrations Sequelize.');
    await sequelize.close();
    return;
  }

  const all = await Utilisateur.findAll({
    where: { totp_enabled: true },
    attributes: ['id', 'email', 'totp_secret', 'totp_enabled'],
  });

  const withSecret    = all.filter(u => u.totp_secret !== null);
  const alreadyCrypted = withSecret.filter(u => isEncrypted(u.totp_secret));
  const plaintext      = withSecret.filter(u => !isEncrypted(u.totp_secret));
  const nullSecret     = all.filter(u => u.totp_secret === null);

  console.log('── Inventaire ──────────────────────────────────────');
  console.log(`  Comptes avec totp_enabled=true        : ${all.length}`);
  console.log(`  Secrets non-nuls                      : ${withSecret.length}`);
  console.log(`  Déjà chiffrés (format iv:tag:ct)      : ${alreadyCrypted.length}`);
  console.log(`  En clair (à migrer)                   : ${plaintext.length}`);
  console.log(`  totp_enabled=true mais secret null    : ${nullSecret.length} ⚠️`);
  console.log('────────────────────────────────────────────────────\n');

  if (plaintext.length === 0) {
    console.log('✅ Aucun secret en clair — migration non nécessaire.');
    await sequelize.close();
    return;
  }

  console.log('── Simulation du rechiffrement ─────────────────────');
  for (const user of plaintext) {
    const preview_before = user.totp_secret.slice(0, 8) + '…';
    const encrypted      = encryptTotpSecret(user.totp_secret);
    const preview_after  = encrypted.slice(0, 20) + '…';

    console.log(`  [${user.email}]`);
    console.log(`    avant  : ${preview_before} (${user.totp_secret.length} chars)`);
    console.log(`    après  : ${preview_after} (${encrypted.length} chars)`);
  }
  console.log('────────────────────────────────────────────────────\n');

  if (DRY_RUN) {
    console.log(`Dry-run terminé. ${plaintext.length} secret(s) seraient rechiffrés.`);
    console.log('Aucune modification apportée à la base de données.');
    console.log('\nPour appliquer : node scripts/migrate-totp-encrypt.js --execute');
  } else {
    console.log(`Application du chiffrement sur ${plaintext.length} compte(s)…`);
    let ok = 0, ko = 0;
    for (const user of plaintext) {
      try {
        const encrypted = encryptTotpSecret(user.totp_secret);
        await Utilisateur.update(
          { totp_secret: encrypted },
          { where: { id: user.id } }
        );
        console.log(`  ✅ ${user.email}`);
        ok++;
      } catch (e) {
        console.error(`  ✗ ${user.email} : ${e.message}`);
        ko++;
      }
    }
    console.log(`\nMigration terminée : ${ok} ok, ${ko} erreurs.`);
  }

  await sequelize.close();
}

main().catch(e => {
  console.error('Erreur inattendue :', e.message);
  process.exit(1);
});
