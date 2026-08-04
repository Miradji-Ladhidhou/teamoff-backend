#!/usr/bin/env node
'use strict';
/**
 * audit-missing-monthly-credits.js — DRY RUN #65
 *
 * Identifie les CompteurConges dont dernier_credit_mensuel est stocké sans
 * zero-padding (ex: "2026-9" au lieu de "2026-09"), ce qui provoque un faux
 * positif hasFutureCredit dans ajouterAcquisitionMensuelle et saute
 * silencieusement les crédits des mois suivants.
 *
 * ⚠️  LECTURE SEULE — aucune modification de données.
 *
 * Usage :
 *   node scripts/audit-missing-monthly-credits.js
 *   node scripts/audit-missing-monthly-credits.js --env .env.production
 */

const path = require('path');

// Support --env <file> pour pointer vers un .env spécifique
const envIdx = process.argv.indexOf('--env');
const envFile = envIdx !== -1
  ? path.resolve(process.argv[envIdx + 1])
  : path.join(__dirname, '../.env');

require('dotenv').config({ path: envFile });

const { sequelize, CompteurConges, Utilisateur, CongeType } = require('../src/models');
const { Op } = require('sequelize');

const NOW_YEAR  = new Date().getFullYear();
const NOW_MONTH = new Date().getMonth() + 1;

function padKey(year, month) {
  return `${year}-${String(month).padStart(2, '0')}`;
}

/**
 * Calcule les mois (au format YYYY-MM) qui ont été sautés à cause du bug
 * de comparaison lexicographique entre un clé non-paddée et une clé zero-paddée.
 */
function computeSkippedMonths(storedKey) {
  // storedKey = "YYYY-M" (single digit, ex: "2026-9")
  const [y, m] = storedKey.split('-').map(Number);
  const skipped = [];
  // Les crédits sautés sont tous ceux où storedKey > paddedTargetKey (= true par erreur)
  // Ce cas arrive pour les mois de (m+1) à 12 du même year où la clé paddée commence
  // par un chiffre inférieur à m (ex: "10", "11", "12" commencent par "1" < "9")
  for (let month = m + 1; month <= 12; month++) {
    // Ne pas dépasser le mois courant
    if (y === NOW_YEAR && month > NOW_MONTH) break;
    const paddedTarget = padKey(y, month);
    if (storedKey > paddedTarget) {
      skipped.push(paddedTarget);
    }
  }
  return skipped;
}

async function main() {
  await sequelize.authenticate();
  console.log('Connexion DB OK\n');

  // Trouver tous les compteurs dont dernier_credit_mensuel fait 6 chars ("YYYY-M")
  // plutôt que 7 ("YYYY-MM")
  const affected = await CompteurConges.findAll({
    where: sequelize.where(
      sequelize.fn('char_length', sequelize.col('dernier_credit_mensuel')),
      6
    ),
    include: [
      {
        model: Utilisateur,
        as: 'utilisateur',
        attributes: ['prenom', 'nom', 'email'],
        required: false,
      },
      {
        model: CongeType,
        as: 'conge_type',
        attributes: ['libelle'],
        required: false,
      },
    ],
    order: [
      ['dernier_credit_mensuel', 'ASC'],
      ['annee', 'ASC'],
    ],
  });

  if (affected.length === 0) {
    console.log('✅  Aucun compteur avec dernier_credit_mensuel non-zero-paddé trouvé.');
    console.log('    La base de données ne présente pas le bug #65 (données saines).');
    await sequelize.close();
    return;
  }

  let totalSkipped = 0;

  console.log(`⚠️   ${affected.length} compteur(s) affecté(s) détecté(s)\n`);
  console.log('─'.repeat(110));
  console.log(
    'COMPTEUR_ID'.padEnd(38) + ' | ' +
    'ANNEE' + ' | ' +
    'UTILISATEUR'.padEnd(28) + ' | ' +
    'TYPE CONGÉ'.padEnd(20) + ' | ' +
    'STOCKÉ' + ' | ' +
    'MOIS PROBABLEMENT SAUTÉS'
  );
  console.log('─'.repeat(110));

  for (const c of affected) {
    const stored  = c.dernier_credit_mensuel;
    const skipped = computeSkippedMonths(stored);
    totalSkipped += skipped.length;

    const user = c.utilisateur
      ? `${c.utilisateur.prenom || ''} ${c.utilisateur.nom || ''}`.trim() || c.utilisateur_id
      : c.utilisateur_id;
    const type = c.conge_type?.libelle || c.conge_type_id;

    console.log(
      String(c.id).padEnd(38) + ' | ' +
      String(c.annee).padEnd(5) + ' | ' +
      user.substring(0, 28).padEnd(28) + ' | ' +
      type.substring(0, 20).padEnd(20) + ' | ' +
      stored.padEnd(6) + ' | ' +
      (skipped.length > 0 ? skipped.join(', ') : '(aucun dans la fenêtre actuelle)')
    );
  }

  console.log('─'.repeat(110));
  console.log(`\nTotal : ${affected.length} compteur(s) concerné(s), ~${totalSkipped} crédit(s) mensuel(s) manquant(s).`);
  console.log('\n⚠️  AUCUNE modification effectuée — dry run uniquement.');
  console.log('    Pour rattraper les crédits manquants, valider Fix #65 et lancer la procédure de correction.');

  await sequelize.close();
}

main().catch((err) => {
  console.error('Erreur :', err.message);
  process.exit(1);
});
