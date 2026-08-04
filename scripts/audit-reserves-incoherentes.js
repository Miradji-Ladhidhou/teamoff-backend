'use strict';
/**
 * audit-reserves-incoherentes.js
 *
 * DRY-RUN : liste les compteurs où jours_reserves en DB ne correspond pas
 * à la somme réelle des congés en attente (en_attente_manager + valide_manager).
 * N'écrit rien en base.
 *
 * Usage : node scripts/audit-reserves-incoherentes.js
 */

require('dotenv').config();

const { sequelize, CompteurConges, Conge, Utilisateur, CongeType, Entreprise } = require('../src/models');
const { Op } = require('sequelize');
const dayjs = require('dayjs');

function toNumber(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

async function main() {
  console.log('=== Audit réserves incohérentes — DRY RUN (aucune écriture) ===\n');

  // Charger tous les compteurs
  const compteurs = await CompteurConges.findAll({
    include: [
      { model: Utilisateur, as: 'utilisateur', attributes: ['id', 'prenom', 'nom', 'email', 'entreprise_id'] },
      { model: CongeType, as: 'conge_type', attributes: ['id', 'libelle', 'code'] },
    ],
  });

  const results = [];

  for (const c of compteurs) {
    const pendingConges = await Conge.findAll({
      where: {
        utilisateur_id: c.utilisateur_id,
        conge_type_id: c.conge_type_id,
        statut: { [Op.in]: ['en_attente_manager', 'valide_manager'] },
      },
      attributes: ['id', 'jours_calcules', 'date_debut', 'statut'],
    });

    // Ne compter que les congés de l'année du compteur
    const pendingThisYear = pendingConges.filter(
      cg => dayjs(cg.date_debut).year() === c.annee
    );
    const pendingTotal = pendingThisYear.reduce((s, cg) => s + toNumber(cg.jours_calcules), 0);
    const dbReserves = toNumber(c.jours_reserves);
    const ecart = dbReserves - pendingTotal; // positif = trop en DB, négatif = trop peu en DB

    if (ecart !== 0) {
      results.push({
        compteur_id: c.id,
        annee: c.annee,
        utilisateur: c.utilisateur ? `${c.utilisateur.prenom} ${c.utilisateur.nom} <${c.utilisateur.email}>` : c.utilisateur_id,
        entreprise_id: c.utilisateur?.entreprise_id || '?',
        type: c.conge_type ? `${c.conge_type.libelle} (${c.conge_type.code})` : c.conge_type_id,
        jours_acquis: toNumber(c.jours_acquis),
        jours_reserves_db: dbReserves,
        jours_reserves_reel: pendingTotal,
        ecart,
        conges_en_attente: pendingThisYear.map(cg => `${cg.id.slice(0,8)}… [${cg.statut}] ${cg.jours_calcules}j`).join(', ') || '—',
      });
    }
  }

  if (results.length === 0) {
    console.log('✓ Aucune incohérence détectée — tous les compteurs sont cohérents avec les congés en attente.\n');
  } else {
    console.log(`${results.length} compteur(s) incohérent(s) :\n`);
    console.log([
      'compteur_id'.padEnd(38),
      'an'.padEnd(5),
      'acquis'.padEnd(8),
      'réservé DB'.padEnd(12),
      'réservé réel'.padEnd(14),
      'écart'.padEnd(7),
      'utilisateur',
    ].join(' '));
    console.log('-'.repeat(120));

    for (const r of results) {
      const sign = r.ecart > 0 ? '+' : '';
      console.log([
        r.compteur_id.padEnd(38),
        String(r.annee).padEnd(5),
        String(r.jours_acquis).padEnd(8),
        String(r.jours_reserves_db).padEnd(12),
        String(r.jours_reserves_reel).padEnd(14),
        `${sign}${r.ecart}`.padEnd(7),
        r.utilisateur,
      ].join(' '));
      if (r.conges_en_attente !== '—') {
        console.log('  └ congés: ' + r.conges_en_attente);
      }
    }

    console.log('\nLégende écart :');
    console.log('  + : jours_reserves en DB > réel (zeroing antérieur possible — solde affiché sous-estimé)');
    console.log('  - : jours_reserves en DB < réel (reserve manquante — solde affiché surestimé ⚠️)');
  }

  console.log('\nAucune modification n\'a été apportée à la base de données.');
  console.log('Décidez avec votre équipe si une régularisation est nécessaire avant d\'appliquer.');

  await sequelize.close();
}

main().catch(err => { console.error('Erreur :', err); process.exit(1); });
