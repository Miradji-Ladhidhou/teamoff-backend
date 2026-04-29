require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const { sequelize, Conge, CompteurConges } = require('../src/models');
const { createIsolatedContext, cleanupIsolatedContext } = require('./verifyTestContext');

const baseUrl = process.env.CONGES_VERIFY_BASE_URL || 'http://localhost:5500/api';

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

async function main() {
  await sequelize.authenticate();

  let context;
  try {
    context = await createIsolatedContext();
    const employe = context.users.employe;
    const token = context.tokens.employe;
    const congeTypeEntreprise = context.congeTypes.primary;
    const congeTypeAutreEntreprise = context.congeTypes.outsider;

    const checks = [];
    const createdIds = [];

    const basePayload = {
      utilisateur_id: employe.id,
      conge_type_id: congeTypeEntreprise.id,
      date_debut: context.dates.createAStart,
      date_fin: context.dates.createAEnd,
      debut_demi_journee: 'matin',
      fin_demi_journee: 'apres_midi',
      commentaire_employe: 'Test coeur metier conges',
    };

    const createOk = await apiRequest(token, 'POST', '/conges/demande', basePayload);
    const createdCongeId = createOk.json?.id || null;
    if (createdCongeId) createdIds.push(createdCongeId);

    checks.push({
      check: 'Creation demande valide',
      ok: createOk.status === 201,
      status: createOk.status,
      message: createOk.json?.message || null,
    });

    if (createdCongeId) {
      const congeDb = await Conge.findByPk(createdCongeId);
      checks.push({
        check: 'Persistance champs conge',
        ok:
          Boolean(congeDb)
          && congeDb.utilisateur_id === employe.id
          && congeDb.entreprise_id === employe.entreprise_id
          && congeDb.conge_type_id === congeTypeEntreprise.id
          && congeDb.date_debut === basePayload.date_debut
          && congeDb.date_fin === basePayload.date_fin
          && congeDb.debut_demi_journee === basePayload.debut_demi_journee
          && congeDb.fin_demi_journee === basePayload.fin_demi_journee
          && congeDb.statut === 'en_attente_manager',
        statut: congeDb?.statut || null,
        note: 'Le schema SQL ne persiste pas jours_calcules; verification basee sur les champs coeur et les compteurs.',
      });

      const compteur = await CompteurConges.findOne({
        where: {
          utilisateur_id: employe.id,
          conge_type_id: congeTypeEntreprise.id,
          annee: Number(basePayload.date_debut.slice(0, 4)),
        },
      });

      checks.push({
        check: 'Compteur reserve mis a jour',
        ok: Boolean(compteur) && Number.isFinite(Number(compteur.jours_reserves)) && Number(compteur.jours_reserves) > 0,
        jours_reserves: compteur?.jours_reserves || null,
      });
    }

    const overlapPayload = {
      ...basePayload,
      date_debut: basePayload.date_debut,
      date_fin: basePayload.date_debut,
    };
    const overlap = await apiRequest(token, 'POST', '/conges/demande', overlapPayload);
    checks.push({
      check: 'Blocage chevauchement',
      ok: overlap.status === 400,
      status: overlap.status,
      message: overlap.json?.message || null,
    });

    const invalidHalfDayPayload = {
      ...basePayload,
      date_debut: context.dates.invalidHalfDayDate,
      date_fin: context.dates.invalidHalfDayDate,
      debut_demi_journee: 'apres_midi',
      fin_demi_journee: 'matin',
    };
    const invalidHalfDay = await apiRequest(token, 'POST', '/conges/demande', invalidHalfDayPayload);
    checks.push({
      check: 'Blocage demi-journee incoherente',
      ok: invalidHalfDay.status === 400,
      status: invalidHalfDay.status,
      message: invalidHalfDay.json?.message || null,
    });

    if (congeTypeAutreEntreprise) {
      const wrongTypePayload = {
        ...basePayload,
        date_debut: context.dates.wrongTypeStart,
        date_fin: context.dates.wrongTypeEnd,
        conge_type_id: congeTypeAutreEntreprise.id,
      };
      const wrongType = await apiRequest(token, 'POST', '/conges/demande', wrongTypePayload);
      checks.push({
        check: 'Blocage type conge autre entreprise',
        ok: wrongType.status === 400,
        status: wrongType.status,
        message: wrongType.json?.message || null,
      });
    } else {
      checks.push({
        check: 'Blocage type conge autre entreprise',
        ok: true,
        skipped: true,
        reason: 'Aucun type de conge trouve dans une autre entreprise pour ce jeu de donnees.',
      });
    }

    const list = await apiRequest(token, 'GET', '/conges');
    const listHasComputedFields = Array.isArray(list.json)
      ? list.json.some((item) => item?.date_demande && Object.prototype.hasOwnProperty.call(item, 'jours_pris'))
      : false;
    checks.push({
      check: 'Liste conges enrichie (date_demande, jours_pris)',
      ok: list.status === 200 && listHasComputedFields,
      status: list.status,
    });

    for (const id of createdIds) {
      const deleted = await apiRequest(token, 'DELETE', `/conges/${id}`);
      checks.push({
        check: `Nettoyage conge ${id}`,
        ok: deleted.status === 204,
        status: deleted.status,
      });
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
  } finally {
    await cleanupIsolatedContext(context);
  }
}

main()
  .catch((error) => {
    console.error('VERIFY_CONGES_CORE_ERROR', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await sequelize.close();
  });
