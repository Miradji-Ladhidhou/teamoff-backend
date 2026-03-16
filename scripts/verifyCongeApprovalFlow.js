require('dotenv').config();

const jwt = require('jsonwebtoken');
const { Op } = require('sequelize');
const { sequelize, Utilisateur, CongeType, Conge, CompteurConges } = require('../src/models');

const baseUrl = process.env.CONGES_VERIFY_BASE_URL || 'http://localhost:5500/api';

function isoDate(offsetDays) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

function nextBusinessDate(offsetDays) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + offsetDays);

  while (d.getDay() === 0 || d.getDay() === 6) {
    d.setDate(d.getDate() + 1);
  }

  return d.toISOString().slice(0, 10);
}

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

async function createCongeWithRetry(token, payload, retries = 20) {
  let startOffset = 0;

  for (let attempt = 0; attempt < retries; attempt += 1) {
    const shiftedPayload = {
      ...payload,
      date_debut: nextBusinessDate(startOffset + payload.baseStartOffset),
      date_fin: nextBusinessDate(startOffset + payload.baseEndOffset),
    };

    const { baseStartOffset, baseEndOffset, ...sendPayload } = shiftedPayload;

    const response = await apiRequest(token, 'POST', '/conges/demande', sendPayload);
    const message = response.json?.message || '';

    if (response.status === 201) {
      return { response, finalPayload: sendPayload, attempts: attempt + 1 };
    }

    if (!message.includes('Nombre de jours de congé invalide')) {
      return { response, finalPayload: sendPayload, attempts: attempt + 1 };
    }

    startOffset += 1;
  }

  return {
    response: { status: 400, json: { message: 'Echec creation apres retries sur jours ouvrés' } },
    finalPayload: payload,
    attempts: retries,
  };
}

async function main() {
  await sequelize.authenticate();

  const employe = await Utilisateur.findOne({ where: { role: 'employe' }, order: [['created_at', 'ASC']] });
  if (!employe) throw new Error('Aucun employe trouve.');

  const manager = await Utilisateur.findOne({
    where: {
      role: 'manager',
      entreprise_id: employe.entreprise_id,
    },
    order: [['created_at', 'ASC']],
  });
  if (!manager) throw new Error('Aucun manager trouve dans la meme entreprise que l employe.');

  const admin = await Utilisateur.findOne({
    where: {
      role: 'admin_entreprise',
      entreprise_id: employe.entreprise_id,
    },
    order: [['created_at', 'ASC']],
  });

  const superAdmin = await Utilisateur.findOne({
    where: { role: 'super_admin' },
    order: [['created_at', 'ASC']],
  });

  const finalApprover = admin || superAdmin;
  if (!finalApprover) throw new Error('Aucun admin_entreprise ni super_admin trouve pour la validation finale.');

  const congeType = await CongeType.findOne({
    where: { entreprise_id: employe.entreprise_id },
    order: [['created_at', 'ASC']],
  });
  if (!congeType) throw new Error('Aucun type de conge trouve pour l entreprise de test.');

  const employeToken = jwt.sign(
    { id: employe.id, role: employe.role, entreprise_id: employe.entreprise_id },
    process.env.JWT_SECRET,
    { expiresIn: '20m' }
  );
  const managerToken = jwt.sign(
    { id: manager.id, role: manager.role, entreprise_id: manager.entreprise_id },
    process.env.JWT_SECRET,
    { expiresIn: '20m' }
  );
  const adminToken = jwt.sign(
    { id: finalApprover.id, role: finalApprover.role, entreprise_id: finalApprover.entreprise_id },
    process.env.JWT_SECRET,
    { expiresIn: '20m' }
  );

  const checks = [];
  const createdCongeIds = [];
  const compteurSnapshots = new Map();

  async function snapshotCompteurFor(dateDebut) {
    const year = Number(String(dateDebut).slice(0, 4));
    const key = `${employe.id}::${congeType.id}::${year}`;
    const compteur = await CompteurConges.findOne({
      where: {
        utilisateur_id: employe.id,
        conge_type_id: congeType.id,
        annee: year,
      },
    });

    if (!compteurSnapshots.has(key)) {
      compteurSnapshots.set(key, {
        key,
        utilisateur_id: employe.id,
        conge_type_id: congeType.id,
        entreprise_id: employe.entreprise_id,
        annee: year,
        existed: Boolean(compteur),
        values: compteur
          ? {
              jours_acquis: compteur.jours_acquis,
              jours_pris: compteur.jours_pris,
              jours_reportes: compteur.jours_reportes,
              jours_reserves: compteur.jours_reserves,
            }
          : null,
      });
    }

    return compteur;
  }

  try {
    const payloadA = {
      utilisateur_id: employe.id,
      conge_type_id: congeType.id,
      baseStartOffset: 60,
      baseEndOffset: 61,
      debut_demi_journee: 'matin',
      fin_demi_journee: 'apres_midi',
      commentaire_employe: 'TEST_APPROVAL_FLOW_A',
    };

    const createAResult = await createCongeWithRetry(employeToken, payloadA);
    const createA = createAResult.response;
    const payloadAResolved = createAResult.finalPayload;

    await snapshotCompteurFor(payloadAResolved.date_debut);

    checks.push({
      check: 'A - Creation employee',
      ok: createA.status === 201,
      status: createA.status,
      message: createA.json?.message || null,
      attempts: createAResult.attempts,
    });
    const congeAId = createA.json?.id || null;
    if (congeAId) createdCongeIds.push(congeAId);

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
        annee: Number(payloadAResolved.date_debut.slice(0, 4)),
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
      baseStartOffset: 75,
      baseEndOffset: 75,
      debut_demi_journee: 'matin',
      fin_demi_journee: 'apres_midi',
      commentaire_employe: 'TEST_APPROVAL_FLOW_B',
    };

    const createBResult = await createCongeWithRetry(employeToken, payloadB);
    const createB = createBResult.response;
    const payloadBResolved = createBResult.finalPayload;

    await snapshotCompteurFor(payloadBResolved.date_debut);

    checks.push({
      check: 'B - Creation employee',
      ok: createB.status === 201,
      status: createB.status,
      message: createB.json?.message || null,
      attempts: createBResult.attempts,
    });
    const congeBId = createB.json?.id || null;
    if (congeBId) createdCongeIds.push(congeBId);

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
      baseStartOffset: 90,
      baseEndOffset: 91,
      debut_demi_journee: 'matin',
      fin_demi_journee: 'apres_midi',
      commentaire_employe: 'TEST_APPROVAL_FLOW_C',
    };

    const createCResult = await createCongeWithRetry(employeToken, payloadC);
    const createC = createCResult.response;
    const payloadCResolved = createCResult.finalPayload;

    await snapshotCompteurFor(payloadCResolved.date_debut);

    checks.push({
      check: 'C - Creation employee',
      ok: createC.status === 201,
      status: createC.status,
      message: createC.json?.message || null,
      attempts: createCResult.attempts,
    });
    const congeCId = createC.json?.id || null;
    if (congeCId) createdCongeIds.push(congeCId);

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
  } finally {
    // Nettoyage des conges de test
    if (createdCongeIds.length > 0) {
      await Conge.destroy({ where: { id: { [Op.in]: createdCongeIds } } });
    }

    // Restauration des compteurs a l etat initial
    for (const snapshot of compteurSnapshots.values()) {
      if (!snapshot.existed) {
        await CompteurConges.destroy({
          where: {
            utilisateur_id: snapshot.utilisateur_id,
            conge_type_id: snapshot.conge_type_id,
            annee: snapshot.annee,
          },
        });
      } else {
        await CompteurConges.update(
          {
            jours_acquis: snapshot.values.jours_acquis,
            jours_pris: snapshot.values.jours_pris,
            jours_reportes: snapshot.values.jours_reportes,
            jours_reserves: snapshot.values.jours_reserves,
          },
          {
            where: {
              utilisateur_id: snapshot.utilisateur_id,
              conge_type_id: snapshot.conge_type_id,
              annee: snapshot.annee,
            },
          }
        );
      }
    }
  }

  const failed = checks.filter((item) => item.ok === false);
  const report = {
    baseUrl,
    allOk: failed.length === 0,
    failedCount: failed.length,
    checks,
  };

  console.log(JSON.stringify(report, null, 2));

  if (failed.length > 0) {
    process.exitCode = 1;
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
