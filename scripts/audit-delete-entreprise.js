#!/usr/bin/env node
/**
 * audit-delete-entreprise.js — DRY-RUN uniquement, aucune écriture en base.
 *
 * Objectif : pour une entreprise donnée (ou toutes), lister le nombre
 * d'enregistrements qui seraient affectés par une suppression :
 *   • CASCADE  → supprimés automatiquement par PostgreSQL
 *   • SET NULL → conservés avec entreprise_id = NULL (audit_logs, holiday_templates)
 *
 * Problème détecté (#20) : l'ORM ne déclare pas le comportement de cascade,
 * et holiday_templates.source_entreprise_id est CASCADE au lieu de SET NULL
 * (des templates créés par l'entreprise seraient détruits au lieu d'être conservés).
 *
 * Usage :
 *   node scripts/audit-delete-entreprise.js
 *   node scripts/audit-delete-entreprise.js <entreprise_id>
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const { sequelize, Entreprise } = require('../src/models');
const { QueryTypes } = require('sequelize');

async function cnt(sql, eid) {
  const rows = await sequelize.query(sql, {
    type: QueryTypes.SELECT,
    replacements: { eid },
  });
  return rows[0]?.n ?? 0;
}

async function countFor(entrepriseId) {
  const u     = await cnt('SELECT COUNT(*)::int AS n FROM utilisateur WHERE entreprise_id = :eid', entrepriseId);
  const c     = await cnt('SELECT COUNT(*)::int AS n FROM conge WHERE entreprise_id = :eid', entrepriseId);
  const ct    = await cnt('SELECT COUNT(*)::int AS n FROM conge_type WHERE entreprise_id = :eid', entrepriseId);
  const cc    = await cnt('SELECT COUNT(*)::int AS n FROM compteur_conges WHERE entreprise_id = :eid', entrepriseId);
  const jf    = await cnt('SELECT COUNT(*)::int AS n FROM jours_feries WHERE entreprise_id = :eid', entrepriseId);
  const notif = await cnt('SELECT COUNT(*)::int AS n FROM notification WHERE entreprise_id = :eid', entrepriseId);
  const abs   = await cnt('SELECT COUNT(*)::int AS n FROM "Absences" WHERE entreprise_id = :eid', entrepriseId);
  const lp    = await cnt('SELECT COUNT(*)::int AS n FROM leave_policy WHERE entreprise_id = :eid', entrepriseId);
  const al    = await cnt('SELECT COUNT(*)::int AS n FROM audit_logs WHERE entreprise_id = :eid', entrepriseId);
  const ht    = await cnt('SELECT COUNT(*)::int AS n FROM holiday_templates WHERE source_entreprise_id = :eid', entrepriseId);
  return { u, c, ct, cc, jf, notif, abs, lp, al, ht };
}

async function main() {
  const targetId = process.argv[2] || null;

  console.log('=== Audit #20 : impact de la suppression d\'entreprise ===');
  console.log('Mode : DRY-RUN — aucune modification en base\n');

  const enterprises = targetId
    ? await Entreprise.findAll({ where: { id: targetId } })
    : await Entreprise.findAll({ order: [['nom', 'ASC']] });

  if (enterprises.length === 0) {
    console.log('Aucune entreprise trouvée.');
    process.exit(0);
  }

  let grandTotal = 0;
  let totalHolidayTemplates = 0;

  for (const ent of enterprises) {
    const r = await countFor(ent.id);
    const cascadeTotal = r.u + r.c + r.ct + r.cc + r.jf + r.notif + r.abs + r.lp;

    console.log(`╔══════════════════════════════════════════════════════╗`);
    console.log(`  ${ent.nom} (${ent.id})`);
    console.log(`╚══════════════════════════════════════════════════════╝`);
    console.log(`  SERAIENT SUPPRIMÉS (CASCADE) :`);
    console.log(`    utilisateurs       : ${r.u}`);
    console.log(`    congés             : ${r.c}`);
    console.log(`    types de congé     : ${r.ct}`);
    console.log(`    compteurs          : ${r.cc}`);
    console.log(`    jours fériés       : ${r.jf}`);
    console.log(`    notifications      : ${r.notif}`);
    console.log(`    absences           : ${r.abs}`);
    console.log(`    leave_policy       : ${r.lp}`);
    console.log(`    ─────────────────────────────`);
    console.log(`    TOTAL cascade      : ${cascadeTotal}`);
    console.log('');
    console.log(`  SERAIENT CONSERVÉS (SET NULL) :`);
    console.log(`    audit_logs         : ${r.al}  (entreprise_id → NULL)`);
    console.log('');

    const htSuffix = r.ht > 0
      ? `⚠️  ACTUELLEMENT CASCADE — seraient SUPPRIMÉS (bug : devrait être SET NULL)`
      : 'aucun';
    console.log(`  HOLIDAY TEMPLATES (source_entreprise_id) : ${r.ht}  ${htSuffix}`);
    console.log('');

    grandTotal += cascadeTotal;
    totalHolidayTemplates += r.ht;
  }

  console.log(`══════════════════════════════════════════════════════`);
  console.log(`TOTAL toutes entreprises`);
  console.log(`  Records cascade-supprimés     : ${grandTotal}`);
  console.log(`  Audit logs préservés (SET NULL): (voir détails ci-dessus)`);

  if (totalHolidayTemplates > 0) {
    console.log('');
    console.log(`⚠️  BUG DÉTECTÉ : ${totalHolidayTemplates} holiday_template(s) seraient SUPPRIMÉS`);
    console.log('   lors d\'une suppression d\'entreprise (holiday_templates.source_entreprise_id');
    console.log('   est CASCADE en base — devrait être SET NULL pour conserver les templates).');
    console.log('   Fix requis : migration + update HolidayTemplate model + models/index.js');
  } else {
    console.log('');
    console.log('ℹ️  Aucun holiday_template affecté sur cette base (table vide).');
    console.log('   Le bug holiday_templates.source_entreprise_id CASCADE → SET NULL');
    console.log('   doit néanmoins être corrigé avant toute suppression d\'entreprise en prod.');
  }

  process.exit(0);
}

main().catch(err => {
  console.error('Erreur script audit:', err);
  process.exit(1);
});
