'use strict';
/**
 * audit-feries-recurrents.js
 *
 * DRY-RUN : recalcule les congés déjà validés impactés par le bug des fériés récurrents.
 * N'écrit rien en base. Affiche les écarts entre l'ancien décompte (jours_calcules en DB)
 * et le nouveau décompte (avec fériés récurrents correctement pris en compte).
 *
 * Usage : node scripts/audit-feries-recurrents.js
 */

require('dotenv').config();

const dayjs = require('dayjs');
const isSameOrBefore = require('dayjs/plugin/isSameOrBefore');
dayjs.extend(isSameOrBefore);

const { sequelize, Conge, JoursFeries, Entreprise } = require('../src/models');

// Logique extraite de congesService — version corrigée avec récurrence
function buildJoursFeriesLookup(joursFeries) {
  const exactSet = new Set();
  const recurrentSet = new Set();
  for (const jf of joursFeries || []) {
    if (jf.est_travail) continue;
    const d = dayjs(jf.date);
    if (jf.recurrent) {
      recurrentSet.add(d.format('MM-DD'));
    } else {
      exactSet.add(d.format('YYYY-MM-DD'));
    }
  }
  return { exactSet, recurrentSet };
}

function buildJoursFeriesLookupLegacy(joursFeries) {
  // Ancienne logique : Set YYYY-MM-DD, pas de récurrence, pas de filtre est_travail
  return new Set((joursFeries || []).map(jf => dayjs(jf.date).format('YYYY-MM-DD')));
}

function isHolidayLegacy(dateKey, legacySet) {
  return legacySet.has(dateKey);
}

function isHolidayFixed(current, lookup) {
  return lookup.exactSet.has(current.format('YYYY-MM-DD')) || lookup.recurrentSet.has(current.format('MM-DD'));
}

function calcJoursLegacy(dateDebut, dateFin, debutDemi, finDemi, legacySet) {
  let total = 0;
  let cur = dayjs(dateDebut);
  const end = dayjs(dateFin);
  while (cur.isSameOrBefore(end, 'day')) {
    const day = cur.day();
    const dk = cur.format('YYYY-MM-DD');
    if (day !== 0 && day !== 6 && !isHolidayLegacy(dk, legacySet)) total++;
    cur = cur.add(1, 'day');
  }
  if (total > 0) {
    if (debutDemi === 'apres_midi') total -= 0.5;
    if (finDemi === 'matin') total -= 0.5;
  }
  return total;
}

function calcJoursFixed(dateDebut, dateFin, debutDemi, finDemi, lookup) {
  let total = 0;
  let cur = dayjs(dateDebut);
  const end = dayjs(dateFin);
  while (cur.isSameOrBefore(end, 'day')) {
    const day = cur.day();
    if (day !== 0 && day !== 6 && !isHolidayFixed(cur, lookup)) total++;
    cur = cur.add(1, 'day');
  }
  if (total > 0) {
    if (debutDemi === 'apres_midi') total -= 0.5;
    if (finDemi === 'matin') total -= 0.5;
  }
  return total;
}

async function main() {
  console.log('=== Audit fériés récurrents — DRY RUN (aucune écriture en base) ===\n');

  // 1. Récupérer les entreprises ayant des fériés récurrents
  const feriesRecurrents = await JoursFeries.findAll({ where: { recurrent: true } });
  const entrepriseIdsAvecRecurrents = [...new Set(feriesRecurrents.map(jf => jf.entreprise_id))];

  if (entrepriseIdsAvecRecurrents.length === 0) {
    console.log('Aucune entreprise n\'a de jours fériés récurrents en base.');
    await sequelize.close();
    return;
  }

  console.log(`${entrepriseIdsAvecRecurrents.length} entreprise(s) avec fériés récurrents :\n`);

  let totalCongesImpactes = 0;
  let totalJoursEcart = 0;

  for (const entrepriseId of entrepriseIdsAvecRecurrents) {
    const entreprise = await Entreprise.findByPk(entrepriseId, { attributes: ['id', 'nom'] });
    const joursFeries = await JoursFeries.findAll({ where: { entreprise_id: entrepriseId } });

    const legacySet = buildJoursFeriesLookupLegacy(joursFeries);
    const fixedLookup = buildJoursFeriesLookup(joursFeries);

    // Fériés récurrents de cette entreprise
    const recurrents = joursFeries.filter(jf => jf.recurrent && !jf.est_travail);
    console.log(`\n[${entreprise?.nom || entrepriseId}]`);
    console.log(`  Fériés récurrents : ${recurrents.map(jf => `${jf.libelle} (${dayjs(jf.date).format('MM-DD')})`).join(', ')}`);

    // Congés validés ou pris touchant potentiellement un férié récurrent
    const conges = await Conge.findAll({
      where: {
        entreprise_id: entrepriseId,
        statut: ['valide', 'pris'],
      },
      attributes: ['id', 'date_debut', 'date_fin', 'debut_demi_journee', 'fin_demi_journee', 'jours_calcules', 'utilisateur_id'],
    });

    const impacts = [];
    for (const conge of conges) {
      const ancien = calcJoursLegacy(conge.date_debut, conge.date_fin, conge.debut_demi_journee, conge.fin_demi_journee, legacySet);
      const nouveau = calcJoursFixed(conge.date_debut, conge.date_fin, conge.debut_demi_journee, conge.fin_demi_journee, fixedLookup);
      const ecart = ancien - nouveau; // positif = sur-décompte

      if (ecart !== 0) {
        impacts.push({
          conge_id: conge.id,
          utilisateur_id: conge.utilisateur_id,
          periode: `${conge.date_debut} → ${conge.date_fin}`,
          jours_en_db: parseFloat(conge.jours_calcules),
          ancien_calcul: ancien,
          nouveau_calcul: nouveau,
          ecart_jours: ecart,
        });
        totalJoursEcart += ecart;
      }
    }

    if (impacts.length === 0) {
      console.log('  Aucun congé validé impacté par le bug.');
    } else {
      console.log(`  ${impacts.length} congé(s) impacté(s) :\n`);
      console.log('  ' + [
        'conge_id'.padEnd(38),
        'période'.padEnd(25),
        'DB'.padEnd(6),
        'ancien'.padEnd(8),
        'nouveau'.padEnd(9),
        'écart',
      ].join(' '));
      console.log('  ' + '-'.repeat(96));
      for (const imp of impacts) {
        console.log('  ' + [
          imp.conge_id.padEnd(38),
          imp.periode.padEnd(25),
          String(imp.jours_en_db).padEnd(6),
          String(imp.ancien_calcul).padEnd(8),
          String(imp.nouveau_calcul).padEnd(9),
          `+${imp.ecart_jours}j sur-décompté`,
        ].join(' '));
      }
      totalCongesImpactes += impacts.length;
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log(`TOTAL : ${totalCongesImpactes} congé(s) impacté(s), ${totalJoursEcart} jour(s) sur-décompté(s)`);
  console.log('\nAucune modification n\'a été apportée à la base de données.');
  console.log('Décidez avec votre équipe si une régularisation rétroactive des soldes est nécessaire.');

  await sequelize.close();
}

main().catch(err => {
  console.error('Erreur :', err);
  process.exit(1);
});
