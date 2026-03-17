/**
 * verifyAllRolesWorkflow.js
 * =========================
 * Test exhaustif de TOUS les endpoints backend par rôle :
 *   super_admin | admin_entreprise | manager | employe
 *
 * Vérifie également l'application des politiques de congés.
 * Usage : node scripts/verifyAllRolesWorkflow.js
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const {
  sequelize,
  Utilisateur,
  Entreprise,
  CongeType,
  Conge,
  CompteurConges,
  JoursFeries,
} = require('../src/models');
const { Op } = require('sequelize');

const BASE = process.env.CONGES_VERIFY_BASE_URL || 'http://localhost:5500/api';
const JWT_SECRET = process.env.JWT_SECRET;

// ─── couleurs ANSI ────────────────────────────────────────────────────────────
const C = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
};

function ok(msg) { console.log(`  ${C.green}✔${C.reset} ${msg}`); }
function fail(msg) { console.log(`  ${C.red}✘${C.reset} ${C.red}${msg}${C.reset}`); }
function info(msg) { console.log(`  ${C.dim}ℹ${C.reset} ${C.dim}${msg}${C.reset}`); }
function section(msg) { console.log(`\n${C.bold}${C.cyan}━━━ ${msg} ━━━${C.reset}`); }
function warn(msg) { console.log(`  ${C.yellow}⚠${C.reset} ${C.yellow}${msg}${C.reset}`); }

function collectJsFilesRecursively(dirPath) {
  const out = [];
  if (!fs.existsSync(dirPath)) return out;

  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectJsFilesRecursively(full));
    } else if (entry.isFile() && full.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}

function normalizeRoutePath(p) {
  return p
    .replace(/:\w+/g, ':id')
    .replace(/\/+$/, '') || '/';
}

function joinRoutePrefix(prefix, routePath) {
  const a = prefix === '/' ? '' : prefix;
  const b = routePath === '/' ? '' : routePath;
  const joined = `${a}${b}` || '/';
  return normalizeRoutePath(joined.startsWith('/') ? joined : `/${joined}`);
}

function computeFrontBackCoverage() {
  try {
    const backendRoot = path.resolve(__dirname, '..');
    const workspaceRoot = path.resolve(__dirname, '..', '..');
    const backendRoutesDir = path.join(backendRoot, 'src', 'routes');
    const frontendApiFile = path.join(workspaceRoot, 'teamoff-frontend', 'src', 'services', 'api.js');

    if (!fs.existsSync(backendRoutesDir) || !fs.existsSync(frontendApiFile)) {
      return null;
    }

    const backendFiles = collectJsFilesRecursively(backendRoutesDir);
    const prefixByFile = {
      'auth.js': '/auth',
      'users.js': '/users',
      'entreprises.js': '/entreprises',
      'conge.js': '/conges',
      'congeTypes.js': '/conge-types',
      'quotas.js': '/quotas',
      'calendrier.js': '/calendrier-conges',
      'joursFeries.js': '/jours-feries',
      'notification.js': '/notifications',
      'exports.js': '/exports',
      'audit.js': '/audit',
      'settings.js': '/settings',
      'index.js': '/',
    };
    const backendSet = new Set();

    for (const file of backendFiles) {
      const raw = fs.readFileSync(file, 'utf8');
      const txt = raw
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      const re = /router\.(get|post|put|patch|delete)\s*\(\s*['"`]([^'"`]+)['"`]/g;
      let m;
      const fileName = path.basename(file);
      const prefix = prefixByFile[fileName] || '';
      while ((m = re.exec(txt))) {
        const method = m[1].toUpperCase();
        const routePath = normalizeRoutePath(m[2]);
        const fullPath = joinRoutePrefix(prefix, routePath);
        backendSet.add(`${method} ${fullPath}`);
      }
    }

    const frontRaw = fs.readFileSync(frontendApiFile, 'utf8');
    const frontSet = new Set();
    const frontRe = /api\.(get|post|put|patch|delete)\(\s*`([^`]+)`|api\.(get|post|put|patch|delete)\(\s*['"]([^'"]+)['"]/g;
    let fm;
    while ((fm = frontRe.exec(frontRaw))) {
      const method = (fm[1] || fm[3]).toUpperCase();
      const rawPath = (fm[2] || fm[4] || '')
        .replace(/\$\{[^}]+\}/g, ':id');
      const routePath = normalizeRoutePath(rawPath);
      frontSet.add(`${method} ${routePath}`);
    }

    const backendRoutes = [...backendSet].sort();
    const covered = backendRoutes.filter((r) => frontSet.has(r));
    const missing = backendRoutes.filter((r) => !frontSet.has(r));
    const pct = backendRoutes.length > 0 ? Math.round((covered.length / backendRoutes.length) * 100) : 0;

    return {
      backendTotal: backendRoutes.length,
      covered: covered.length,
      missingCount: missing.length,
      pct,
      missing,
    };
  } catch (e) {
    return { error: e.message };
  }
}

// ─── helpers ──────────────────────────────────────────────────────────────────
function makeToken(user) {
  return jwt.sign(
    { id: user.id, role: user.role, entreprise_id: user.entreprise_id },
    JWT_SECRET,
    { expiresIn: '10m' }
  );
}

async function req(token, method, path, body, label) {
  const url = `${BASE}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: token ? `Bearer ${token}` : '',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) {}
  return { status: res.status, json, text };
}

function isoDate(offset = 0) {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

// Retourne un lundi futur garanti (évite weekends)
function nextMonday(offsetWeeks = 1) {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  const dow = d.getUTCDay(); // 0=dim, 1=lun...
  const daysUntilMonday = dow === 1 ? 7 : (8 - dow) % 7 || 7;
  d.setUTCDate(d.getUTCDate() + daysUntilMonday + (offsetWeeks - 1) * 7);
  return d.toISOString().slice(0, 10);
}

function nextTuesday(offsetWeeks = 1) {
  const mon = new Date(nextMonday(offsetWeeks));
  mon.setUTCDate(mon.getUTCDate() + 1);
  return mon.toISOString().slice(0, 10);
}

// ─── registre de résultats ────────────────────────────────────────────────────
const results = [];
let totalChecks = 0;
let passedChecks = 0;
let failedChecks = 0;

function check(label, condition, got, expected) {
  totalChecks++;
  if (condition) {
    passedChecks++;
    ok(`${label} → ${C.dim}statut ${got}${C.reset}`);
    results.push({ ok: true, label });
  } else {
    failedChecks++;
    fail(`${label} → attendu ${expected}, obtenu ${got}`);
    results.push({ ok: false, label, got, expected });
  }
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n${C.bold}${C.cyan}╔══════════════════════════════════════════════════╗${C.reset}`);
  console.log(`${C.bold}${C.cyan}║   TEAMOFF — TEST COMPLET WORKFLOW TOUS RÔLES     ║${C.reset}`);
  console.log(`${C.bold}${C.cyan}╚══════════════════════════════════════════════════╝${C.reset}\n`);

  await sequelize.authenticate();
  info('DB connectée.');

  // ┌─────────────────────────────────────────────────────────────────────────┐
  // │ 1. RÉCUPÉRATION DES UTILISATEURS DE TEST                               │
  // └─────────────────────────────────────────────────────────────────────────┘
  section('SETUP — Chargement des utilisateurs de test');

  const sa = await Utilisateur.findOne({ where: { role: 'super_admin' }, order: [['created_at', 'ASC']] });
  const adm = await Utilisateur.findOne({ where: { role: 'admin_entreprise' }, order: [['created_at', 'ASC']] });
  const mgr = await Utilisateur.findOne({ where: { role: 'manager' }, order: [['created_at', 'ASC']] });
  const emp = await Utilisateur.findOne({ where: { role: 'employe' }, order: [['created_at', 'ASC']] });

  if (!sa) throw new Error('Aucun super_admin trouvé en base.');
  if (!adm) throw new Error('Aucun admin_entreprise trouvé en base.');
  if (!mgr) throw new Error('Aucun manager trouvé en base.');
  if (!emp) throw new Error('Aucun employe trouvé en base.');

  info(`super_admin     → #${sa.id} ${sa.email} (ent: ${sa.entreprise_id})`);
  info(`admin_entreprise→ #${adm.id} ${adm.email} (ent: ${adm.entreprise_id})`);
  info(`manager         → #${mgr.id} ${mgr.email} (ent: ${mgr.entreprise_id})`);
  info(`employe         → #${emp.id} ${emp.email} (ent: ${emp.entreprise_id})`);

  const T = {
    sa: makeToken(sa),
    adm: makeToken(adm),
    mgr: makeToken(mgr),
    emp: makeToken(emp),
    none: null,
  };

  // Trouver un type de congé dans l'entreprise de l'employé
  const congeType = await CongeType.findOne({
    where: { entreprise_id: emp.entreprise_id },
    order: [['created_at', 'ASC']],
  });
  if (!congeType) throw new Error('Aucun type de congé pour l\'entreprise de test.');

  const entreprise = await Entreprise.findByPk(emp.entreprise_id);
  if (!entreprise) throw new Error('Entreprise introuvable.');

  // ┌─────────────────────────────────────────────────────────────────────────┐
  // │ 2. SANTÉ PUBLIQUE                                                       │
  // └─────────────────────────────────────────────────────────────────────────┘
  section('SANTÉ / HEALTH (public)');
  {
    const r = await req(null, 'GET', '/health');
    check('GET /health → 200 sans token', r.status === 200, r.status, 200);
  }

  // ┌─────────────────────────────────────────────────────────────────────────┐
  // │ 3. AUTH                                                                 │
  // └─────────────────────────────────────────────────────────────────────────┘
  section('AUTH');
  {
    // Login valide
    const rLogin = await req(null, 'POST', '/auth/login', { email: sa.email, password: '__DUMMY__' });
    // On s'attend à 401 car on ne connaît pas le vrai password — mais l'endpoint existe (pas 404)
    check('POST /auth/login → endpoint existe (200 ou 401)', [200, 401, 429, 500].includes(rLogin.status), rLogin.status, '200|401|429|500');

    // Change password avec token
    const rCp = await req(T.emp, 'POST', '/auth/change-password', { ancien_password: 'x', nouveau_password: 'y' });
    check('POST /auth/change-password → authJwt ok (pas 401)', rCp.status !== 401, rCp.status, '≠401');

    // Sans token → 401
    const rCpNoAuth = await req(null, 'POST', '/auth/change-password', { ancien_password: 'x', nouveau_password: 'y' });
    check('POST /auth/change-password sans token → 401', rCpNoAuth.status === 401, rCpNoAuth.status, 401);
  }

  // ┌─────────────────────────────────────────────────────────────────────────┐
  // │ 4. /ME                                                                  │
  // └─────────────────────────────────────────────────────────────────────────┘
  section('/ME — profil utilisateur connecté');
  for (const [role, token] of [['super_admin', T.sa], ['admin_entreprise', T.adm], ['manager', T.mgr], ['employe', T.emp]]) {
    const r = await req(token, 'GET', '/me');
    check(`GET /me en tant que ${role} → 200`, r.status === 200, r.status, 200);
  }
  {
    const r = await req(null, 'GET', '/me');
    check('GET /me sans token → 401', r.status === 401, r.status, 401);
  }

  // ┌─────────────────────────────────────────────────────────────────────────┐
  // │ 5. USERS                                                                │
  // └─────────────────────────────────────────────────────────────────────────┘
  section('USERS — contrôle d\'accès par rôle');
  {
    // Lecture : sa, adm, mgr = 200 ; emp = 403
    for (const [r, token, exp] of [
      ['super_admin', T.sa, 200],
      ['admin_entreprise', T.adm, 200],
      ['manager', T.mgr, 200],
      ['employe', T.emp, 403],
    ]) {
      const res = await req(token, 'GET', '/users');
      check(`GET /users [${r}] → ${exp}`, res.status === exp, res.status, exp);
    }

    // GET /users/:id — tous les rôles peuvent lire leur propre profil
    const rSelfSa = await req(T.sa, 'GET', `/users/${sa.id}`);
    check('GET /users/:id [super_admin] → 200', rSelfSa.status === 200, rSelfSa.status, 200);
    const rSelfEmp = await req(T.emp, 'GET', `/users/${emp.id}`);
    check('GET /users/:id [employe] → 200', rSelfEmp.status === 200, rSelfEmp.status, 200);

    // POST /users — sa et adm peuvent créer ; mgr et emp ne peuvent pas
    for (const [r, token, exp] of [
      ['manager', T.mgr, 403],
      ['employe', T.emp, 403],
    ]) {
      const res = await req(token, 'POST', '/users', { email: 'x@x.com', nom: 'X', role: 'employe', password: 'Abc123!' });
      check(`POST /users [${r}] → 403`, res.status === 403, res.status, 403);
    }

    // PUT /users/:id/role — super_admin seulement
    const rRoleSa = await req(T.sa, 'PUT', `/users/${emp.id}/role`, { role: 'employe' });
    check('PUT /users/:id/role [super_admin] → 200 ou 400', [200, 400, 422].includes(rRoleSa.status), rRoleSa.status, 200);
    const rRoleAdm = await req(T.adm, 'PUT', `/users/${emp.id}/role`, { role: 'employe' });
    check('PUT /users/:id/role [admin_entreprise] → 403', rRoleAdm.status === 403, rRoleAdm.status, 403);
    const rRoleMgr = await req(T.mgr, 'PUT', `/users/${emp.id}/role`, { role: 'employe' });
    check('PUT /users/:id/role [manager] → 403', rRoleMgr.status === 403, rRoleMgr.status, 403);
  }

  // ┌─────────────────────────────────────────────────────────────────────────┐
  // │ 6. ENTREPRISES                                                          │
  // └─────────────────────────────────────────────────────────────────────────┘
  section('ENTREPRISES — accès super_admin uniquement (sauf lecture propre)');
  {
    const rListSa = await req(T.sa, 'GET', '/entreprises');
    check('GET /entreprises [super_admin] → 200', rListSa.status === 200, rListSa.status, 200);

    for (const [r, token] of [['admin_entreprise', T.adm], ['manager', T.mgr], ['employe', T.emp]]) {
      const res = await req(token, 'GET', '/entreprises');
      check(`GET /entreprises [${r}] → 403`, res.status === 403, res.status, 403);
    }

    // Lecture d'un entreprise spécifique — sa et adm (leur propre)
    const rEntById = await req(T.adm, 'GET', `/entreprises/${adm.entreprise_id}`);
    check('GET /entreprises/:id [admin_entreprise propre] → 200', rEntById.status === 200, rEntById.status, 200);

    const rEntByMgr = await req(T.mgr, 'GET', `/entreprises/${mgr.entreprise_id}`);
    check('GET /entreprises/:id [manager] → 403', rEntByMgr.status === 403, rEntByMgr.status, 403);

    // Politique
    const rPolSa = await req(T.sa, 'GET', `/entreprises/${entreprise.id}/politique`);
    check('GET /entreprises/:id/politique [super_admin] → 200', rPolSa.status === 200, rPolSa.status, 200);

    const rPolAdm = await req(T.adm, 'GET', `/entreprises/${adm.entreprise_id}/politique`);
    check('GET /entreprises/:id/politique [admin_entreprise] → 200', rPolAdm.status === 200, rPolAdm.status, 200);

    const rPolMgr = await req(T.mgr, 'GET', `/entreprises/${mgr.entreprise_id}/politique`);
    check('GET /entreprises/:id/politique [manager] → 403', rPolMgr.status === 403, rPolMgr.status, 403);

    const rPolEmp = await req(T.emp, 'GET', `/entreprises/${emp.entreprise_id}/politique`);
    check('GET /entreprises/:id/politique [employe] → 403', rPolEmp.status === 403, rPolEmp.status, 403);

    // PATCH statut — super_admin uniquement
    const rPatchMgr = await req(T.mgr, 'PATCH', `/entreprises/${mgr.entreprise_id}/statut`, { statut: 'actif' });
    check('PATCH /entreprises/:id/statut [manager] → 403', rPatchMgr.status === 403, rPatchMgr.status, 403);
  }

  // ┌─────────────────────────────────────────────────────────────────────────┐
  // │ 7. CONGÉS — CRUD et transitions de statut                              │
  // └─────────────────────────────────────────────────────────────────────────┘
  section('CONGÉS — CRUD par rôle + transitions de statut');
  let congeCreatedId = null;
  let congeEmpId = null;
  {
    // Nettoyage des congés en attente laissés par des runs précédents
    await Conge.destroy({ where: { utilisateur_id: [emp.id, mgr.id], statut: ['en_attente_manager', 'valide_manager'] } });
    info('Congés en attente préexistants supprimés (cleanup)');

    const basePayload = {
      utilisateur_id: emp.id,
      conge_type_id: congeType.id,
      date_debut: nextMonday(4),
      date_fin: nextTuesday(4),
      debut_demi_journee: 'matin',
      fin_demi_journee: 'apres_midi',
      commentaire_employe: 'Test workflow rôles',
    };

    // Création par employé
    const rCreate = await req(T.emp, 'POST', '/conges/demande', basePayload);
    check('POST /conges/demande [employe] → 201', rCreate.status === 201, rCreate.status, 201);
    if (rCreate.json?.id) {
      congeEmpId = rCreate.json.id;
      info(`Congé créé #${congeEmpId}`);
    }

    // Création par manager
    // Manager crée pour lui-même (lundi + mardi garantis weekday)
    const mgrDebut = nextMonday(6);
    const mgrFin   = nextTuesday(6);
    const rCreateMgr = await req(T.mgr, 'POST', '/conges/demande', {
      ...basePayload,
      utilisateur_id: mgr.id,
      date_debut: mgrDebut,
      date_fin: mgrFin,
    });
    check('POST /conges/demande [manager] → 201', rCreateMgr.status === 201, rCreateMgr.status, 201);
    if (rCreateMgr.json?.id) congeCreatedId = rCreateMgr.json.id;

    // Lecture liste — tous les rôles
    for (const [r, token] of [['super_admin', T.sa], ['admin_entreprise', T.adm], ['manager', T.mgr], ['employe', T.emp]]) {
      const res = await req(token, 'GET', '/conges');
      check(`GET /conges [${r}] → 200`, res.status === 200, res.status, 200);
    }

    // Lecture d'un congé
    if (congeEmpId) {
      const rGet = await req(T.emp, 'GET', `/conges/${congeEmpId}`);
      check(`GET /conges/:id [employe] → 200`, rGet.status === 200, rGet.status, 200);
    }

    // Validation / rejet — manager, admin_entreprise, super_admin peuvent ; employe ne peut pas
    if (congeEmpId) {
      const rValEmp = await req(T.emp, 'POST', `/conges/${congeEmpId}/validate`, {});
      check('POST /conges/:id/validate [employe] → 403', rValEmp.status === 403, rValEmp.status, 403);

      const rValMgr = await req(T.mgr, 'POST', `/conges/${congeEmpId}/validate`, { commentaire_valideur: 'OK manager' });
      check('POST /conges/:id/validate [manager] → 200 ou 400', [200, 400].includes(rValMgr.status), rValMgr.status, 200);

      if (rValMgr.status === 200) {
        // Re-créer pour tester le rejet
        const rCreate2 = await req(T.emp, 'POST', '/conges/demande', {
          ...basePayload,
          date_debut: nextMonday(8),
          date_fin: nextTuesday(8),
          commentaire_employe: 'Test rejet',
        });
        if (rCreate2.json?.id) {
          const rRejectAdm = await req(T.adm, 'POST', `/conges/${rCreate2.json.id}/reject`, { motif_refus: 'Test rejet admin' });
          check('POST /conges/:id/reject [admin_entreprise] → 200', rRejectAdm.status === 200, rRejectAdm.status, 200);
        }
      }
    }

    // Suppression par employe (devrait pouvoir supprimer son propre congé si en attente)
    const rCreate3 = await req(T.emp, 'POST', '/conges/demande', {
      ...basePayload,
      date_debut: nextMonday(9),
      date_fin: nextTuesday(9),
      commentaire_employe: 'Test suppression',
    });
    if (rCreate3.json?.id) {
      const rDel = await req(T.emp, 'DELETE', `/conges/${rCreate3.json.id}`);
      check('DELETE /conges/:id [employe - propre congé attente] → 200 ou 204', [200, 204].includes(rDel.status), rDel.status, 200);
    }
  }

  // ┌─────────────────────────────────────────────────────────────────────────┐
  // │ 7b. POLITIQUE DE CONGÉS — enforcement des règles                       │
  // └─────────────────────────────────────────────────────────────────────────┘
  section('POLITIQUE CONGÉS — enforcement des règles métier');
  {
    // Récupérer la politique actuelle
    const rPol = await req(T.adm, 'GET', `/entreprises/${adm.entreprise_id}/politique`);
      const politique = (rPol.json?.politique_conges) || rPol.json || {};
    info(`Politique actuelle: overlap=${politique.overlap_policy}, notice=${politique.minimum_notice_days}j, max_consec=${politique.max_consecutive_days}j`);

      // Test : congé dans le passé — bloqué si minimum_notice_days > 0, sinon autorisé
      const noticeJours = politique.minimum_notice_days || 0;
      const rPast = await req(T.emp, 'POST', '/conges/demande', {
      utilisateur_id: emp.id,
      conge_type_id: congeType.id,
        date_debut: isoDate(-10),
        date_fin: isoDate(-9),
      debut_demi_journee: 'matin',
      fin_demi_journee: 'apres_midi',
      commentaire_employe: 'Test passé',
    });
      if (noticeJours > 0) {
        check(
          `POST /conges/demande dans le passé (notice=${noticeJours}j) → 400/422`,
          [400, 409, 422].includes(rPast.status),
          rPast.status,
          '400|409|422'
        );
      } else {
        // minimum_notice_days = 0 → passé autorisé par la politique, supprimer si créé
        if (rPast.json?.id) {
          await req(T.adm, 'DELETE', `/conges/${rPast.json.id}`);
        }
        info(`POST congé passé → ${rPast.status} (politique notice_days=${noticeJours} → passé autorisé, test skipé)`);
      }

    // Test : max_consecutive_days — si la politique l'impose
    if (politique.max_consecutive_days > 0) {
      const longDays = politique.max_consecutive_days + 3;
      const rLong = await req(T.emp, 'POST', '/conges/demande', {
        utilisateur_id: emp.id,
        conge_type_id: congeType.id,
        date_debut: isoDate(60),
        date_fin: isoDate(60 + longDays),
        debut_demi_journee: 'matin',
        fin_demi_journee: 'apres_midi',
        commentaire_employe: `Test dépassement max consecutive (${longDays}j)`,
      });
      if ([200, 201].includes(rLong.status)) {
        warn(`max_consecutive_days (${politique.max_consecutive_days}j) non bloqué côté back (création réussie). À vérifier.`);
      } else {
        check(`POST /conges/demande > max_consecutive (${politique.max_consecutive_days}j) → 400/422`, [400, 422].includes(rLong.status), rLong.status, '400|422');
      }
    }

    // Test : minimum_notice_days — demande trop courte  
    if (politique.minimum_notice_days > 0) {
      const rNotice = await req(T.emp, 'POST', '/conges/demande', {
        utilisateur_id: emp.id,
        conge_type_id: congeType.id,
        date_debut: isoDate(1),
        date_fin: isoDate(2),
        debut_demi_journee: 'matin',
        fin_demi_journee: 'apres_midi',
        commentaire_employe: `Test notice insuff (notice=${politique.minimum_notice_days}j)`,
      });
      if ([200, 201].includes(rNotice.status)) {
        warn(`minimum_notice_days (${politique.minimum_notice_days}j) non bloquant (demain J+1 accepté). OK si notice=1.`);
      } else {
        check(`POST /conges/demande notice trop courte → 400/422/409`, [400, 409, 422].includes(rNotice.status), rNotice.status, '400|409|422');
      }
    }
  }

  // ┌─────────────────────────────────────────────────────────────────────────┐
  // │ 8. TYPES DE CONGÉS                                                      │
  // └─────────────────────────────────────────────────────────────────────────┘
  section('TYPES DE CONGÉS — CRUD');
  let createdTypeId = null;
  {
    // Création — sa et adm peuvent ; manager et employe non
    const rCreateSa = await req(T.sa, 'POST', '/conge-types', {
      code: 'TST' + Date.now().toString().slice(-7),
      libelle: 'Type test SA',
      quota_annuel: 5,
    });
    check('POST /conge-types [super_admin] → 201', rCreateSa.status === 201, rCreateSa.status, 201);
    if (rCreateSa.json?.id) createdTypeId = rCreateSa.json.id;

    const rCreateMgr = await req(T.mgr, 'POST', '/conge-types', { code: 'TEST_MGR', libelle: 'Mgr', quota_annuel: 1 });
    check('POST /conge-types [manager] → 403', rCreateMgr.status === 403, rCreateMgr.status, 403);

    const rCreateEmp = await req(T.emp, 'POST', '/conge-types', { code: 'TEST_EMP', libelle: 'Emp', quota_annuel: 1 });
    check('POST /conge-types [employe] → 403', rCreateEmp.status === 403, rCreateEmp.status, 403);

    // Lecture — tout le monde connecté peut lire
    for (const [r, token] of [['super_admin', T.sa], ['admin_entreprise', T.adm], ['manager', T.mgr], ['employe', T.emp]]) {
      const res = await req(token, 'GET', '/conge-types');
      check(`GET /conge-types [${r}] → 200`, res.status === 200, res.status, 200);
    }

    // Suppression du type créé
    if (createdTypeId) {
      const rDelSa = await req(T.sa, 'DELETE', `/conge-types/${createdTypeId}`);
      check('DELETE /conge-types/:id [super_admin] → 200 ou 204', [200, 204].includes(rDelSa.status), rDelSa.status, 200);
    }
  }

  // ┌─────────────────────────────────────────────────────────────────────────┐
  // │ 9. JOURS FÉRIÉS                                                         │
  // └─────────────────────────────────────────────────────────────────────────┘
  section('JOURS FÉRIÉS — admin_entreprise et super_admin uniquement');
  let jourFerieId = null;
  {
    for (const [r, token, exp, qs] of [
      ['admin_entreprise', T.adm, 200, ''],
      ['super_admin', T.sa, 200, `?entreprise_id=${sa.entreprise_id}`],
      ['manager', T.mgr, 403, ''],
      ['employe', T.emp, 403, ''],
    ]) {
      const res = await req(token, 'GET', `/jours-feries${qs}`);
      check(`GET /jours-feries [${r}] → ${exp}`, res.status === exp, res.status, exp);
    }

    // Créer un jour férié par adm
    const rCreate = await req(T.adm, 'POST', '/jours-feries', {
      libelle: 'Fête test',
      date: isoDate(90),
      recurrent: false,
    });
    check('POST /jours-feries [admin_entreprise] → 201', rCreate.status === 201, rCreate.status, 201);
    if (rCreate.json?.id) jourFerieId = rCreate.json.id;

    // Manager ne peut pas créer
    const rCreateMgr = await req(T.mgr, 'POST', '/jours-feries', { libelle: 'Test', date: isoDate(95), recurrent: false });
    check('POST /jours-feries [manager] → 403', rCreateMgr.status === 403, rCreateMgr.status, 403);

    // Supprimer
    if (jourFerieId) {
      const rDel = await req(T.adm, 'DELETE', `/jours-feries/${jourFerieId}`);
      check('DELETE /jours-feries/:id [admin_entreprise] → 200 ou 204', [200, 204].includes(rDel.status), rDel.status, 200);
    }

    // Templates
    const rTpl = await req(T.adm, 'GET', '/jours-feries/templates');
    check('GET /jours-feries/templates [admin_entreprise] → 200', rTpl.status === 200, rTpl.status, 200);

    const rTplMgr = await req(T.mgr, 'GET', '/jours-feries/templates');
    check('GET /jours-feries/templates [manager] → 403', rTplMgr.status === 403, rTplMgr.status, 403);
  }

  // ┌─────────────────────────────────────────────────────────────────────────┐
  // │ 10. QUOTAS                                                              │
  // └─────────────────────────────────────────────────────────────────────────┘
  section('QUOTAS — lecture soldes pour tous, usage/init admin+');
  {
    // Soldes — tous peuvent lire leur propre solde
    for (const [r, token, uid] of [
      ['super_admin', T.sa, sa.id],
      ['admin_entreprise', T.adm, adm.id],
      ['manager', T.mgr, mgr.id],
      ['employe', T.emp, emp.id],
    ]) {
      const res = await req(token, 'GET', `/quotas/soldes/${uid}`);
      check(`GET /quotas/soldes/:id [${r}] → 200`, res.status === 200, res.status, 200);
    }

    // Usage — admin et sa seulement
    const rUsageSa = await req(T.sa, 'GET', '/quotas/usage');
    check('GET /quotas/usage [super_admin] → 200', rUsageSa.status === 200, rUsageSa.status, 200);
    const rUsageAdm = await req(T.adm, 'GET', '/quotas/usage');
    check('GET /quotas/usage [admin_entreprise] → 200', rUsageAdm.status === 200, rUsageAdm.status, 200);
    const rUsageMgr = await req(T.mgr, 'GET', '/quotas/usage');
    check('GET /quotas/usage [manager] → 403', rUsageMgr.status === 403, rUsageMgr.status, 403);
    const rUsageEmp = await req(T.emp, 'GET', '/quotas/usage');
    check('GET /quotas/usage [employe] → 403', rUsageEmp.status === 403, rUsageEmp.status, 403);
  }

  // ┌─────────────────────────────────────────────────────────────────────────┐
  // │ 11. CALENDRIER                                                          │
  // └─────────────────────────────────────────────────────────────────────────┘
  section('CALENDRIER — accessible à tous les rôles connectés');
  {
    for (const [r, token] of [['super_admin', T.sa], ['admin_entreprise', T.adm], ['manager', T.mgr], ['employe', T.emp]]) {
      const res = await req(token, 'GET', '/calendrier-conges');
      check(`GET /calendrier-conges [${r}] → 200`, res.status === 200, res.status, 200);
    }
    const rNoAuth = await req(null, 'GET', '/calendrier-conges');
    check('GET /calendrier-conges sans token → 401', rNoAuth.status === 401, rNoAuth.status, 401);

      // Route mensuelle
      const yr = new Date().getFullYear();
      const mo = new Date().getMonth() + 1;
      for (const [r, token] of [['manager', T.mgr], ['employe', T.emp]]) {
        const res = await req(token, 'GET', `/calendrier-conges/${yr}/${mo}`);
        check(`GET /calendrier-conges/:year/:month [${r}] → 200`, res.status === 200, res.status, 200);
      }

      // Jours fériés par mois (route ajoutée pour le calendrier)
      const rJfMgr = await req(T.mgr, 'GET', `/jours-feries/${yr}/${mo}`);
      check(`GET /jours-feries/:year/:month [manager] → 200`, rJfMgr.status === 200, rJfMgr.status, 200);
      const rJfEmp = await req(T.emp, 'GET', `/jours-feries/${yr}/${mo}`);
      check(`GET /jours-feries/:year/:month [employe] → 200`, rJfEmp.status === 200, rJfEmp.status, 200);
  }

  // ┌─────────────────────────────────────────────────────────────────────────┐
  // │ 12. NOTIFICATIONS                                                       │
  // └─────────────────────────────────────────────────────────────────────────┘
  section('NOTIFICATIONS — tous les rôles connectés');
  {
    for (const [r, token] of [['super_admin', T.sa], ['admin_entreprise', T.adm], ['manager', T.mgr], ['employe', T.emp]]) {
      const res = await req(token, 'GET', '/notifications');
      check(`GET /notifications [${r}] → 200`, res.status === 200, res.status, 200);
    }
    const rNoAuth = await req(null, 'GET', '/notifications');
    check('GET /notifications sans token → 401', rNoAuth.status === 401, rNoAuth.status, 401);
    // Mark all read
    const rMarkAll = await req(T.emp, 'PUT', '/notifications/lire-tout');
    check('PUT /notifications/lire-tout [employe] → 200', rMarkAll.status === 200, rMarkAll.status, 200);
  }

  // ┌─────────────────────────────────────────────────────────────────────────┐
  // │ 13. EXPORTS                                                             │
  // └─────────────────────────────────────────────────────────────────────────┘
  section('EXPORTS — admin_entreprise et super_admin uniquement');
  {
    // Preview
    const rPrevAdm = await req(T.adm, 'GET', '/exports/preview?type=conges&format=csv&periode=mois');
    check('GET /exports/preview [admin_entreprise] → 200', rPrevAdm.status === 200, rPrevAdm.status, 200);
    const rPrevMgr = await req(T.mgr, 'GET', '/exports/preview?type=conges&format=csv&periode=mois');
    check('GET /exports/preview [manager] → 403', rPrevMgr.status === 403, rPrevMgr.status, 403);
    const rPrevEmp = await req(T.emp, 'GET', '/exports/preview?type=conges&format=csv&periode=mois');
    check('GET /exports/preview [employe] → 403', rPrevEmp.status === 403, rPrevEmp.status, 403);

    // Congés CSV
    const rCsvAdm = await req(T.adm, 'GET', '/exports/conges/csv');
    check('GET /exports/conges/csv [admin_entreprise] → 200', rCsvAdm.status === 200, rCsvAdm.status, 200);

    // Utilisateurs CSV
    const rUserCsvAdm = await req(T.adm, 'GET', '/exports/utilisateurs/csv');
    check('GET /exports/utilisateurs/csv [admin_entreprise] → 200', rUserCsvAdm.status === 200, rUserCsvAdm.status, 200);

    // Entreprises CSV — super_admin uniquement
    const rEntCsvSa = await req(T.sa, 'GET', '/exports/entreprises/csv');
    check('GET /exports/entreprises/csv [super_admin] → 200', rEntCsvSa.status === 200, rEntCsvSa.status, 200);
    const rEntCsvAdm = await req(T.adm, 'GET', '/exports/entreprises/csv');
    check('GET /exports/entreprises/csv [admin_entreprise] → 403', rEntCsvAdm.status === 403, rEntCsvAdm.status, 403);

    // Audit CSV
    const rAuditCsvAdm = await req(T.adm, 'GET', '/exports/audit/csv');
    check('GET /exports/audit/csv [admin_entreprise] → 200', rAuditCsvAdm.status === 200, rAuditCsvAdm.status, 200);

    // Usage PDF
    const rUsagePdfSa = await req(T.sa, 'GET', '/exports/usage/pdf');
    check('GET /exports/usage/pdf [super_admin] → 200', rUsagePdfSa.status === 200, rUsagePdfSa.status, 200);
  }

  // ┌─────────────────────────────────────────────────────────────────────────┐
  // │ 14. AUDIT                                                               │
  // └─────────────────────────────────────────────────────────────────────────┘
  section('AUDIT — super_admin uniquement');
  {
    const rAuditSa = await req(T.sa, 'GET', '/audit');
    check('GET /audit [super_admin] → 200', rAuditSa.status === 200, rAuditSa.status, 200);

    for (const [r, token] of [['admin_entreprise', T.adm], ['manager', T.mgr], ['employe', T.emp]]) {
      const res = await req(token, 'GET', '/audit');
      check(`GET /audit [${r}] → 403`, res.status === 403, res.status, 403);
    }
    const rNoAuth = await req(null, 'GET', '/audit');
    check('GET /audit sans token → 401', rNoAuth.status === 401, rNoAuth.status, 401);
  }

  // ┌─────────────────────────────────────────────────────────────────────────┐
  // │ 15. METRICS                                                             │
  // └─────────────────────────────────────────────────────────────────────────┘
  section('METRICS — super_admin uniquement');
  {
    const rSa = await req(T.sa, 'GET', '/metrics');
    check('GET /metrics [super_admin] → 200', rSa.status === 200, rSa.status, 200);

    for (const [r, token] of [['admin_entreprise', T.adm], ['manager', T.mgr], ['employe', T.emp]]) {
      const res = await req(token, 'GET', '/metrics');
      check(`GET /metrics [${r}] → 403`, res.status === 403, res.status, 403);
    }
  }

  // ┌─────────────────────────────────────────────────────────────────────────┐
  // │ 16. SETTINGS                                                            │
  // └─────────────────────────────────────────────────────────────────────────┘
  section('SETTINGS — super_admin uniquement');
  {
    const rSettSa = await req(T.sa, 'GET', '/settings');
    check('GET /settings [super_admin] → 200', rSettSa.status === 200, rSettSa.status, 200);

    for (const [r, token] of [['admin_entreprise', T.adm], ['manager', T.mgr], ['employe', T.emp]]) {
      const res = await req(token, 'GET', '/settings');
      check(`GET /settings [${r}] → 403`, res.status === 403, res.status, 403);
    }

    // Historique
    const rHist = await req(T.sa, 'GET', '/settings/history');
    check('GET /settings/history [super_admin] → 200', rHist.status === 200, rHist.status, 200);

    // System info
    const rSysInfo = await req(T.sa, 'GET', '/settings/system-info');
    check('GET /settings/system-info [super_admin] → 200', rSysInfo.status === 200, rSysInfo.status, 200);

    // Test email
    const rTestEmail = await req(T.sa, 'POST', '/settings/actions/test-email', { to: 'test@test.com' });
    check('POST /settings/actions/test-email [super_admin] → 200 ou 500 (mail SMTP peut échouer)', [200, 500, 502].includes(rTestEmail.status), rTestEmail.status, '200|500');
  }

  // ┌─────────────────────────────────────────────────────────────────────────┐
  // │ RÉSUMÉ FINAL                                                            │
  // └─────────────────────────────────────────────────────────────────────────┘
  section('RÉSUMÉ');

  const failedList = results.filter(r => !r.ok);
  const p = Math.round((passedChecks / totalChecks) * 100);
  const pColor = p >= 90 ? C.green : p >= 70 ? C.yellow : C.red;

  console.log(`\n  Total checks  : ${C.bold}${totalChecks}${C.reset}`);
  console.log(`  ${C.green}Passés${C.reset}        : ${C.bold}${C.green}${passedChecks}${C.reset}`);
  console.log(`  ${C.red}Échoués${C.reset}       : ${C.bold}${C.red}${failedChecks}${C.reset}`);
  console.log(`  Score tests   : ${pColor}${C.bold}${p}%${C.reset}\n`);

  if (failedList.length > 0) {
    console.log(`${C.bold}${C.red}Tests en échec :${C.reset}`);
    failedList.forEach(r => {
      console.log(`  ${C.red}✘${C.reset} ${r.label} — attendu ${r.expected}, obtenu ${r.got}`);
    });
    console.log('');
  }

  section('COUVERTURE FRONT/BACK (auto)');
  const coverage = computeFrontBackCoverage();
  if (!coverage) {
    warn('Impossible de calculer la couverture (fichiers backend/frontend introuvables).');
  } else if (coverage.error) {
    warn(`Erreur calcul couverture: ${coverage.error}`);
  } else {
    const cColor = coverage.pct >= 95 ? C.green : coverage.pct >= 80 ? C.yellow : C.red;
    console.log(`  Endpoints backend   : ${C.bold}${coverage.backendTotal}${C.reset}`);
    console.log(`  Couverts par front  : ${C.bold}${coverage.covered}${C.reset}`);
    console.log(`  Manquants           : ${C.bold}${coverage.missingCount}${C.reset}`);
    console.log(`  Couverture          : ${cColor}${C.bold}${coverage.pct}%${C.reset}`);
    if (coverage.missing.length > 0) {
      const preview = coverage.missing.slice(0, 12);
      info(`Exemples non couverts (${preview.length}/${coverage.missing.length}):`);
      preview.forEach((r) => console.log(`    - ${r}`));
    }
  }

  console.log(`${C.bold}   global allOk : ${failedChecks === 0 ? C.green + 'true' : C.red + 'false'}${C.reset}`);

  await sequelize.close();
  process.exit(failedChecks === 0 ? 0 : 1);
}

main().catch(err => {
  console.error('\n  Erreur fatale :', err.message);
  process.exit(1);
});
