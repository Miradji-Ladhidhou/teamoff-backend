'use strict';

const { parseDatabaseUrl } = require('./migrationSafety');
let importPhase;
const protectedPools = new WeakSet();

function withHarnessImports(phase, callback) {
  if (!['pools', 'app'].includes(phase)) throw new Error('Phase d’import harness invalide.');
  const previous = importPhase;
  importPhase = phase;
  try { return callback(); } finally { importPhase = previous; }
}

function assertHarnessImport(phase) {
  if (phase === 'app' ? importPhase !== 'app' : !['pools', 'app'].includes(importPhase)) {
    throw new Error('Import direct non protégé interdit dans le harness.');
  }
}

const target = Object.freeze({
  host: '127.0.0.1',
  serverAddress: '127.0.0.1/32',
  serverPort: '5432',
  database: 'teamoff_phase4_isolated_20261101',
  databaseOid: '42480',
  databaseOwner: 'teamoff_phase4_owner',
  cluster: '7643503125023720338',
  role: 'teamoff_phase4_app',
});

const identitySQL = `
  SELECT pg_catalog.current_database() AS database,
    (SELECT oid::text FROM pg_catalog.pg_database
      WHERE datname = pg_catalog.current_database()) AS "databaseOid",
    (SELECT pg_catalog.pg_get_userbyid(datdba) FROM pg_catalog.pg_database
      WHERE datname = pg_catalog.current_database()) AS "databaseOwner",
    (SELECT system_identifier::text FROM pg_catalog.pg_control_system()) AS cluster,
    pg_catalog.inet_server_addr()::text AS "serverAddress",
    pg_catalog.inet_server_port()::text AS "serverPort",
    current_user::text AS role, session_user::text AS "sessionRole",
    r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolreplication, r.rolbypassrls,
    EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member = r.oid) AS membership,
    pg_catalog.has_database_privilege(current_user, pg_catalog.current_database(), 'CREATE') AS "databaseCreate",
    pg_catalog.has_database_privilege(current_user, pg_catalog.current_database(), 'TEMP') AS temporary,
    pg_catalog.has_schema_privilege(current_user, 'public', 'CREATE') AS "schemaCreate",
    (EXISTS (SELECT 1 FROM pg_catalog.pg_class c WHERE c.relowner = r.oid)
      OR EXISTS (SELECT 1 FROM pg_catalog.pg_type t WHERE t.typowner = r.oid)
      OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.proowner = r.oid)
      OR EXISTS (SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspowner = r.oid)
      OR EXISTS (SELECT 1 FROM pg_catalog.pg_extension e WHERE e.extowner = r.oid)) AS ownership,
    (${catalogSQL()}) AS objects
  FROM pg_catalog.pg_roles r WHERE r.rolname = current_user
`;

const tables = Object.freeze([
  'Absences', 'SequelizeMeta', 'audit_logs', 'compteur_conges', 'conge', 'conge_action_request',
  'conge_imputation', 'conge_type', 'email_logs', 'entreprise', 'holiday_template_items',
  'holiday_templates', 'jours_feries', 'leave_policy', 'mouvement_solde', 'notification',
  'notification_delivery', 'system_settings', 'utilisateur',
]);
const enums = Object.freeze([
  'enum_Absences_type_absence', 'enum_Absences_statut', 'enum_conge_debut_demi_journee',
  'enum_conge_fin_demi_journee', 'enum_conge_statut', 'enum_conge_action_request_type',
  'enum_conge_action_request_statut', 'enum_conge_action_request_debut_demi_journee_demandee',
  'enum_conge_action_request_fin_demi_journee_demandee', 'enum_email_logs_statut',
  'enum_entreprise_statut', 'enum_utilisateur_role', 'enum_utilisateur_statut',
]);
const uuidFunctions = Object.freeze({
  uuid_generate_v1: '', uuid_generate_v1mc: '', uuid_generate_v3: 'uuid, text',
  uuid_generate_v4: '', uuid_generate_v5: 'uuid, text', uuid_nil: '',
  uuid_ns_dns: '', uuid_ns_oid: '', uuid_ns_url: '', uuid_ns_x500: '',
});

function catalogSQL() {
  return `SELECT pg_catalog.json_agg(o) FROM (
    SELECT 'relation' AS kind, n.nspname AS schema, c.relname AS name,
      pg_catalog.pg_get_userbyid(c.relowner) AS owner, c.relkind::text AS subtype,
      parent.relname AS parent, NULL::text AS extension,
      NULL::text AS arguments, NULL::boolean AS "securityDefiner", NULL::text AS version
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_catalog.pg_index i ON i.indexrelid = c.oid
      LEFT JOIN pg_catalog.pg_class parent ON parent.oid = i.indrelid
    WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
    UNION ALL
    SELECT 'type', n.nspname, t.typname, pg_catalog.pg_get_userbyid(t.typowner),
      t.typtype::text, COALESCE(c.relname, element.typname), NULL, NULL, NULL, NULL
    FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
      LEFT JOIN pg_catalog.pg_class c ON c.oid = t.typrelid
      LEFT JOIN pg_catalog.pg_type element ON element.oid = t.typelem
    WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
    UNION ALL
    SELECT 'function', n.nspname, p.proname, pg_catalog.pg_get_userbyid(p.proowner),
      p.prokind::text, NULL, e.extname, pg_catalog.oidvectortypes(p.proargtypes),
      p.prosecdef, NULL
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      LEFT JOIN pg_catalog.pg_depend d ON d.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
        AND d.objid = p.oid AND d.objsubid = 0 AND d.deptype = 'e'
        AND d.refclassid = 'pg_catalog.pg_extension'::pg_catalog.regclass
      LEFT JOIN pg_catalog.pg_extension e ON e.oid = d.refobjid
    WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
    UNION ALL
    SELECT 'extension', n.nspname, e.extname, pg_catalog.pg_get_userbyid(e.extowner),
      NULL, NULL, NULL, NULL, NULL, e.extversion
    FROM pg_catalog.pg_extension e JOIN pg_catalog.pg_namespace n ON n.oid = e.extnamespace
    UNION ALL
    SELECT 'schema', n.nspname, n.nspname, pg_catalog.pg_get_userbyid(n.nspowner),
      NULL, NULL, NULL, NULL, NULL, NULL FROM pg_catalog.pg_namespace n
    WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
  ) o`;
}

function verifyObjects(objects, poolName) {
  const seen = new Set();
  const reject = () => { throw new Error(`Ownership/objets PostgreSQL refusés pour le pool ${poolName}.`); };
  if (!Array.isArray(objects) || !objects.length) reject();
  for (const o of objects) {
    if (!o || typeof o.name !== 'string' || typeof o.owner !== 'string') reject();
    const key = `${o.kind}:${o.schema}:${o.name}:${o.arguments || ''}`;
    if (seen.has(key)) reject();
    seen.add(key);
    if (o.kind === 'extension' && o.name === 'plpgsql') {
      if (o.schema !== 'pg_catalog' || o.owner !== 'utilisateur' || o.version !== '1.0') reject();
      continue;
    }
    if (o.schema !== 'public') reject();
    if (o.kind === 'schema') {
      if (o.name !== 'public' || o.owner !== 'pg_database_owner') reject();
      continue;
    }
    if (o.kind === 'function') {
      if (!Object.hasOwn(uuidFunctions, o.name) || o.arguments !== uuidFunctions[o.name]
        || o.extension !== 'uuid-ossp' || o.owner !== 'utilisateur'
        || o.securityDefiner !== false || o.subtype !== 'f') reject();
      continue;
    }
    if (o.owner !== target.databaseOwner) reject();
    if (o.kind === 'extension') {
      if (o.name !== 'uuid-ossp' || o.version !== '1.1') reject();
    } else if (o.kind === 'relation') {
      if (!(o.subtype === 'r' && tables.includes(o.name))
        && !(o.subtype === 'i' && tables.includes(o.parent))) reject();
    } else if (o.kind === 'type') {
      if (!(o.subtype === 'e' && enums.includes(o.name))
        && !(o.subtype === 'c' && tables.includes(o.name) && o.parent === o.name)
        && !(o.subtype === 'b' && [...tables, ...enums].includes(o.parent)
          && o.name === `_${o.parent}`)) reject();
    } else reject();
  }
  for (const name of tables) if (!seen.has(`relation:public:${name}:`)) reject();
  for (const name of enums) if (!seen.has(`type:public:${name}:`)) reject();
  for (const name of tables) if (!seen.has(`type:public:${name}:`)) reject();
  for (const name of [...tables, ...enums]) if (!seen.has(`type:public:_${name}:`)) reject();
  for (const [name, args] of Object.entries(uuidFunctions)) {
    if (!seen.has(`function:public:${name}:${args}`)) reject();
  }
  for (const key of ['extension:public:uuid-ossp:', 'extension:pg_catalog:plpgsql:', 'schema:public:public:']) {
    if (!seen.has(key)) reject();
  }
}

function loadHarnessConfig(env = process.env) {
  if (env.NODE_ENV !== 'test' || env.TEAMOFF_INTEGRATION_HARNESS !== 'isolated') {
    throw new Error('Harness isolé explicite et NODE_ENV=test obligatoires.');
  }
  if (env.NODE_OPTIONS || Object.keys(env).some(key =>
    (key.startsWith('PG') || key.startsWith('DOTENV_CONFIG_')) && env[key])) {
    throw new Error('Substitutions PG*, dotenv et NODE_OPTIONS interdites dans le harness.');
  }
  const url = parseDatabaseUrl(env.TEAMOFF_HARNESS_DATABASE_URL);
  if (url.hostname !== target.host || url.port !== target.serverPort
    || decodeURIComponent(url.pathname.slice(1)) !== target.database
    || decodeURIComponent(url.username) !== target.role) {
    throw new Error('Cible du harness refusée : copie locale et rôle applicatif dédiés obligatoires.');
  }
  for (const key of ['DATABASE_URL', 'DATABASE_TEST_URL']) {
    if (env[key] && env[key] !== env.TEAMOFF_HARNESS_DATABASE_URL) {
      throw new Error(`Identifiants historiques ou contradictoires refusés : ${key}.`);
    }
  }
  if (env.DATABASE_TEST_NAME && env.DATABASE_TEST_NAME !== target.database) {
    throw new Error('Nom de base de test contradictoire.');
  }
  return { url: env.TEAMOFF_HARNESS_DATABASE_URL, target };
}

async function verifyConnection(connection, poolName) {
  const { rows } = await connection.query(identitySQL);
  const actual = Array.isArray(rows) && rows.length === 1 ? rows[0] : null;
  if (!actual || Object.keys(target).filter(key => key !== 'host').some(key => actual[key] !== target[key])
    || actual.sessionRole !== target.role
    || ['rolsuper', 'rolcreatedb', 'rolcreaterole', 'rolreplication', 'rolbypassrls', 'membership',
      'databaseCreate', 'temporary', 'schemaCreate', 'ownership']
      .some(key => actual[key] !== false)) {
    throw new Error(`Identité PostgreSQL refusée pour le pool ${poolName}.`);
  }
  verifyObjects(actual.objects, poolName);
  return actual;
}

function protectPool(pool, poolName) {
  if (protectedPools.has(pool)) return;
  protectedPools.add(pool);
  pool.addHook('afterConnect', async connection => {
    try {
      await verifyConnection(connection, poolName);
    } catch (error) {
      try { await connection.end(); } catch (cleanupError) {
        error.cleanupError = cleanupError;
      }
      throw error;
    }
  });
}

async function verifyPools(pools) {
  const identities = {};
  for (const [name, pool] of Object.entries(pools)) {
    if (!protectedPools.has(pool)) throw new Error(`Pool ${name} non protégé : import historique ou direct refusé.`);
    const connection = await pool.connectionManager.getConnection();
    let primaryError;
    try {
      identities[name] = await verifyConnection(connection, name);
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      try { await pool.connectionManager.releaseConnection(connection); } catch (error) {
        if (!primaryError) throw error;
        primaryError.cleanupError = error;
      }
    }
  }
  return identities;
}

module.exports = {
  target, identitySQL, tables, enums, uuidFunctions,
  loadHarnessConfig, verifyConnection, verifyObjects, protectPool, verifyPools,
  withHarnessImports, assertHarnessImport,
};
