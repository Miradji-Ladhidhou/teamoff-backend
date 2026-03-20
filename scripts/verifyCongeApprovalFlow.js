require('dotenv').config();

const { sequelize, CompteurConges } = require('../src/models');
const { createIsolatedContext, cleanupIsolatedContext } = require('./verifyTestContext');

const baseUrl = process.env.CONGES_VERIFY_BASE_URL || 'http://localhost:5500/api';

function safeNumber(value) {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

async function apiRequest(token, method, endpoint, body) {
  const response = await fetch(`${baseUrl}${endpoint}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (_) {
    json = null;
  }

  return {
    status: response.status,
    json,
    text,
  };
}

async function createConge(token, payload) {
  const response = await apiRequest(token, 'POST', '/conges/demande', payload);
  return { response, attempts: 1 };
}

async function main() {
  await sequelize.authenticate();

  let context;
  try {
    context = await createIsolatedContext();

    const employe = context.users.employe;
    const manager = context.users.manager;
    const admin = context.users.admin;
    const congeType = context.congeTypes.primary;

    const employeToken = context.tokens.employe;
    const managerToken = context.tokens.manager;
    const adminToken = context.tokens.admin;

    const checks = [];

    const payloadA = {
      utilisateur_id: employe.id,
      conge_type_id: congeType.id,
      date_debut: context.dates.approvalAStart,
      date_fin: context.dates.approvalAEnd,
      debut_demi_journee: 'matin',
      fin_demi_journee: 'apres_midi',
      commentaire_employe: 'TEST_APPROVAL_FLOW_A',
    };

    const createAResult = await createConge(employeToken, payloadA);
    const createA = createAResult.response;

    checks.push({
      check: 'A - Creation employee',
      ok: createA.status === 201,
      status: createA.status,
      message: createA.json?.message || null,
      attempts: createAResult.attempts,
    });
    const congeAId = createA.json?.id || null;

    if (congeAId) {
      const managerValidateA = await apiRequest(managerToken, 'POST', `/conges/${congeAId}/validate`, { commentaire: 'Validation manager test A' });
      checks.push({
        check: 'A - Validation manager',
        ok: managerValidateA.status === 200 && managerValidateA.json?.statut === 'valide_manager',
        status: managerValidateA.status,
        statut: managerValidateA.json?.statut || null,
        message: managerValidateA.json?.message || null,
      });

      const adminValidateA = await apiRequest(adminToken, 'POST', `/conges/${congeAId}/validate`, { commentaire: 'Validation admin finale test A' });
      checks.push({
        check: 'A - Validation admin finale',
        ok: adminValidateA.status === 200 && adminValidateA.json?.statut === 'valide_final',
        status: adminValidateA.status,
        statut: adminValidateA.json?.statut || null,
        message: adminValidateA.json?.message || null,
      });
    } else {
      checks.push({ check: 'A - Validation manager', ok: false, skipped: true, message: 'Creation A sans id' });
      checks.push({ check: 'A - Validation admin finale', ok: false, skipped: true, message: 'Creation A sans id' });
    }

    const compteurAfterA = await CompteurConges.findOne({
      where: {
        utilisateur_id: employe.id,
        conge_type_id: congeType.id,
        annee: Number(payloadA.date_debut.slice(0, 4)),
      },
    });

    checks.push({
      check: 'A - Compteur apres validation finale',
      ok: Boolean(compteurAfterA) && safeNumber(compteurAfterA.jours_pris) > 0,
      jours_pris: compteurAfterA?.jours_pris || null,
      jours_reserves: compteurAfterA?.jours_reserves || null,
    });

    const payloadB = {
      utilisateur_id: employe.id,
      conge_type_id: congeType.id,
      date_debut: context.dates.approvalBStart,
      date_fin: context.dates.approvalBEnd,
      debut_demi_journee: 'matin',
      fin_demi_journee: 'apres_midi',
      commentaire_employe: 'TEST_APPROVAL_FLOW_B',
    };

    const createBResult = await createConge(employeToken, payloadB);
    const createB = createBResult.response;

    checks.push({
      check: 'B - Creation employee',
      ok: createB.status === 201,
      status: createB.status,
      message: createB.json?.message || null,
      attempts: createBResult.attempts,
    });
    const congeBId = createB.json?.id || null;

    if (congeBId) {
      const managerRejectB = await apiRequest(managerToken, 'POST', `/conges/${congeBId}/reject`, { commentaire: 'Refus manager test B' });
      checks.push({
        check: 'B - Refus manager',
        ok: managerRejectB.status === 200 && managerRejectB.json?.statut === 'refuse_manager',
        status: managerRejectB.status,
        statut: managerRejectB.json?.statut || null,
        message: managerRejectB.json?.message || null,
      });
    } else {
      checks.push({ check: 'B - Refus manager', ok: false, skipped: true, message: 'Creation B sans id' });
    }

    const payloadC = {
      utilisateur_id: employe.id,
      conge_type_id: congeType.id,
      date_debut: context.dates.approvalCStart,
      date_fin: context.dates.approvalCEnd,
      debut_demi_journee: 'matin',
      fin_demi_journee: 'apres_midi',
      commentaire_employe: 'TEST_APPROVAL_FLOW_C',
    };

    const createCResult = await createConge(employeToken, payloadC);
    const createC = createCResult.response;

    checks.push({
      check: 'C - Creation employee',
      ok: createC.status === 201,
      status: createC.status,
      message: createC.json?.message || null,
      attempts: createCResult.attempts,
    });
    const congeCId = createC.json?.id || null;

    if (congeCId) {
      const managerValidateC = await apiRequest(managerToken, 'POST', `/conges/${congeCId}/validate`, { commentaire: 'Validation manager test C' });
      checks.push({
        check: 'C - Validation manager',
        ok: managerValidateC.status === 200 && managerValidateC.json?.statut === 'valide_manager',
        status: managerValidateC.status,
        statut: managerValidateC.json?.statut || null,
        message: managerValidateC.json?.message || null,
      });

      const adminRejectC = await apiRequest(adminToken, 'POST', `/conges/${congeCId}/reject`, { commentaire: 'Refus admin final test C' });
      checks.push({
        check: 'C - Refus admin final',
        ok: adminRejectC.status === 200 && adminRejectC.json?.statut === 'refuse_final',
        status: adminRejectC.status,
        statut: adminRejectC.json?.statut || null,
        message: adminRejectC.json?.message || null,
      });

      const invalidTransition = await apiRequest(managerToken, 'POST', `/conges/${congeCId}/validate`, { commentaire: 'Transition invalide' });
      checks.push({
        check: 'C - Blocage transition invalide apres refus final',
        ok: invalidTransition.status === 400,
        status: invalidTransition.status,
        message: invalidTransition.json?.message || null,
      });
    } else {
      checks.push({ check: 'C - Validation manager', ok: false, skipped: true, message: 'Creation C sans id' });
      checks.push({ check: 'C - Refus admin final', ok: false, skipped: true, message: 'Creation C sans id' });
      checks.push({ check: 'C - Blocage transition invalide apres refus final', ok: false, skipped: true, message: 'Creation C sans id' });
    }

    const failed = checks.filter((item) => item.ok === false);
    const report = {
      baseUrl,
      allOk: failed.length === 0,
      failedCount: failed.length,
      checks,
      actors: {
        employeId: employe.id,
        managerId: manager.id,
        adminId: admin.id,
      },
    };

    console.log(JSON.stringify(report, null, 2));

    if (failed.length > 0) {
      process.exitCode = 1;
    }
  } finally {
    await cleanupIsolatedContext(context);
  }
}

main()
  .catch((error) => {
    console.error('VERIFY_CONGES_APPROVAL_ERROR', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await sequelize.close();
  });
