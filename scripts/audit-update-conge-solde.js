#!/usr/bin/env node
/**
 * audit-update-conge-solde.js — DRY-RUN uniquement, aucune écriture en base.
 *
 * Objectif : détecter les CompteurConges potentiellement affectés par le
 * Math.max(0, …) silencieux de l'ancien updateConge (bilan #18).
 *
 * Symptôme recherché :
 *   • jours_acquis = 0  (la valeur "naturelle" aurait été négative → clampage)
 *   • jours_pris   > 0  (des jours ont bien été consommés)
 *   • au moins un congé valide_final existe pour ce compteur
 *   • ET au moins une entrée audit_logs action='conge.updated' existe
 *     pour un congé de ce même utilisateur/type/année (mise à jour après validation)
 *
 * Un compteur avec jours_acquis = 0 peut être légitimement épuisé : ce script
 * signale des SUSPECTS, pas des certitudes. Une vérification manuelle reste
 * nécessaire pour confirmer un vrai déficit masqué.
 *
 * Usage :
 *   node scripts/audit-update-conge-solde.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const { Sequelize, Op } = require('sequelize');
const { CompteurConges, Conge, Utilisateur, Entreprise, AuditLog } = require('../src/models');

async function main() {
  console.log('=== Audit #18 : déficits masqués par Math.max dans updateConge ===');
  console.log('Mode : DRY-RUN — aucune modification en base\n');

  // 1. Récupérer tous les compteurs avec jours_acquis = 0 et jours_pris > 0
  const suspects = await CompteurConges.findAll({
    where: {
      jours_acquis: 0,
      jours_pris: { [Op.gt]: 0 },
    },
    include: [
      {
        model: Utilisateur,
        as: 'utilisateur',
        attributes: ['id', 'prenom', 'nom', 'email'],
        required: false,
      },
      {
        model: Entreprise,
        as: 'entreprise',
        attributes: ['id', 'nom'],
        required: false,
      },
    ],
  });

  if (suspects.length === 0) {
    console.log('Aucun compteur avec jours_acquis=0 et jours_pris>0 trouvé.');
    process.exit(0);
  }

  console.log(`${suspects.length} compteur(s) avec jours_acquis=0 et jours_pris>0 :\n`);

  let confirmedSuspects = 0;

  for (const c of suspects) {
    const utilisateurId = c.utilisateur_id;
    const congeTypeId = c.conge_type_id;
    const annee = c.annee;

    // 2. Chercher les congés valide_final pour ce compteur
    const congesValides = await Conge.findAll({
      where: {
        utilisateur_id: utilisateurId,
        conge_type_id: congeTypeId,
        statut: 'valide_final',
        [Op.and]: Sequelize.where(
          Sequelize.fn('EXTRACT', Sequelize.literal(`YEAR FROM "date_debut"::date`)),
          annee
        ),
      },
      attributes: ['id', 'date_debut', 'date_fin', 'jours_calcules'],
    });

    if (congesValides.length === 0) continue; // pas de valide_final → pas suspect

    // 3. Vérifier si des audit_logs montrent une mise à jour de congé pour cet utilisateur
    const congeIds = congesValides.map(cg => cg.id);
    const auditUpdates = await AuditLog.findAll({
      where: {
        action: 'conge.updated',
        entity: 'conge',
        entity_id: { [Op.in]: congeIds },
      },
      attributes: ['id', 'entity_id', 'created_at'],
      limit: 5,
    });

    const hasAuditUpdate = auditUpdates.length > 0;

    // Calcul : somme des jours_calcules des congés valide_final
    const totalJoursValides = congesValides.reduce(
      (sum, cg) => sum + (Number(cg.jours_calcules) || 0), 0
    );

    const joursPris = Number(c.jours_pris);
    const discrepance = Math.abs(totalJoursValides - joursPris) > 0.01
      ? `⚠️  discordance : sum(jours_calcules)=${totalJoursValides} vs jours_pris=${joursPris}`
      : `OK : sum(jours_calcules)=${totalJoursValides} = jours_pris=${joursPris}`;

    // Afficher les suspects avec au moins 1 audit update OU une discordance
    const hasMismatch = Math.abs(totalJoursValides - joursPris) > 0.01;
    if (hasAuditUpdate || hasMismatch) {
      confirmedSuspects++;
      const nom = c.utilisateur
        ? `${c.utilisateur.prenom} ${c.utilisateur.nom} <${c.utilisateur.email}>`
        : utilisateurId;
      const ent = c.entreprise?.nom || c.entreprise_id;
      console.log(`─────────────────────────────────────────────`);
      console.log(`Compteur : ${c.id}`);
      console.log(`Entreprise : ${ent}`);
      console.log(`Employé   : ${nom}`);
      console.log(`Type/Année : ${congeTypeId} / ${annee}`);
      console.log(`Solde actuel : acquis=${c.jours_acquis} | pris=${c.jours_pris} | réservés=${c.jours_reserves}`);
      console.log(`Congés valide_final : ${congesValides.length} congé(s)`);
      console.log(`Vérification : ${discrepance}`);
      console.log(`Audit updates : ${hasAuditUpdate ? `${auditUpdates.length} entrée(s)` : 'aucune'}`);
      if (hasAuditUpdate) {
        auditUpdates.forEach(a => {
          console.log(`  → conge ${a.entity_id} mis à jour le ${a.created_at?.toISOString?.() || a.created_at}`);
        });
      }
      console.log('');
    }
  }

  if (confirmedSuspects === 0) {
    console.log('\nAucun suspect confirmé (jours_acquis=0 mais pas de mise à jour ni discordance détectée).');
  } else {
    console.log(`\n=== ${confirmedSuspects} suspect(s) à vérifier manuellement ===`);
    console.log('Action recommandée : vérifier chaque compteur avec le responsable RH.');
    console.log('N\'appliquer aucune correction sans accord explicite.');
  }

  process.exit(0);
}

main().catch(err => {
  console.error('Erreur script audit:', err);
  process.exit(1);
});
