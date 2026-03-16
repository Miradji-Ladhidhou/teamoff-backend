require('dotenv').config();

const jwt = require('jsonwebtoken');
const { sequelize, Utilisateur, CongeType, Conge, CompteurConges } = require('../src/models');

const baseUrl = process.env.CONGES_VERIFY_BASE_URL || 'http://localhost:5500/api';

function isoDate(offsetDays) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
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

async function main() {
  await sequelize.authenticate();

  const employe = await Utilisateur.findOne({ where: { role: 'employe' }, order: [['created_at', 'ASC']] });
  if (!employe) throw new Error('Aucun employe trouve pour verifier les demandes de conge.');

  const congeTypeEntreprise = await CongeType.findOne({
    where: { entreprise_id: employe.entreprise_id },
    order: [['created_at', 'ASC']],
  });
  if (!congeTypeEntreprise) throw new Error('Aucun type de conge trouve dans l entreprise de test.');

  const congeTypeAutreEntreprise = await CongeType.findOne({
    where: { entreprise_id: { [require('sequelize').Op.ne]: employe.entreprise_id } },
    order: [['created_at', 'ASC']],
  });

  const token = jwt.sign(
    {
      id: employe.id,
      role: employe.role,
      entreprise_id: employe.entreprise_id,
    },
    process.env.JWT_SECRET,
    { expiresIn: '20m' }
  );

  const checks = [];
  const createdIds = [];

  const basePayload = {
    utilisateur_id: employe.id,
    conge_type_id: congeTypeEntreprise.id,
    date_debut: isoDate(30),
    date_fin: isoDate(31),
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
    date_debut: isoDate(40),
    date_fin: isoDate(40),
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
      date_debut: isoDate(50),
      date_fin: isoDate(51),
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
}

main()
  .catch((error) => {
    console.error('VERIFY_CONGES_CORE_ERROR', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await sequelize.close();
  });
