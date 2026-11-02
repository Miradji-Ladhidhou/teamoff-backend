'use strict';

const { QueryTypes } = require('sequelize');

const expectedStatuses = [
  'reserve', 'en_attente_manager', 'valide_manager', 'refuse_manager', 'valide_final', 'refuse_final',
];

async function verifyStartupSchema(sequelize) {
  const rows = await sequelize.query(`
    SELECT e.enumlabel AS label
    FROM pg_catalog.pg_attribute a
    JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_catalog.pg_type t ON t.oid = a.atttypid
    JOIN pg_catalog.pg_namespace tn ON tn.oid = t.typnamespace
    JOIN pg_catalog.pg_enum e ON e.enumtypid = t.oid
    WHERE n.nspname = 'public' AND c.relname = 'conge' AND c.relkind = 'r'
      AND a.attname = 'statut' AND NOT a.attisdropped
      AND tn.nspname = 'public' AND t.typname = 'enum_conge_statut'
  `, { type: QueryTypes.SELECT });
  const actual = new Set(rows.map(row => row.label));
  const missing = expectedStatuses.filter(status => !actual.has(status));
  if (missing.length) {
    throw new Error(`Schéma PostgreSQL incompatible : public.conge.statut / public.enum_conge_statut ; valeurs manquantes : ${missing.join(', ')}. Aucune modification automatique.`);
  }
}

module.exports = { verifyStartupSchema };
