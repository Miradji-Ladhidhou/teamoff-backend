const { Conge, CompteurConges, CongeType, Utilisateur, Entreprise, sequelize } = require('../models');
const notificationService = require('./notificationService');
const emailService = require('./emailService');
const { auditConge } = require('./auditHelper');
const { logMouvement, descriptionConge } = require('./mouvementSoldeService');
const { ensureCounter } = require('./quotasService');
const LeavePolicyService = require('./leavePolicyService');
const joursFeriesService = require('./joursFeriesService');
const { getLeaveRules, getEffectiveLeaveRules } = require('./politiqueConges');
const { Op } = require('sequelize');
const dayjs = require('dayjs');
const isSameOrBefore = require('dayjs/plugin/isSameOrBefore');
const { validateUUID, validateDateRange, validateDemiJournee } = require('../utils/validation');
const { formatDateFR } = require('../utils/dateFormatter');
const logger = require('../utils/logger');

dayjs.extend(isSameOrBefore);

const FRONTEND_URL = process.env.FRONTEND_URL || '';

function buildCongeUrl(congeId) {
  const path = `/conges/${congeId}`;
  return FRONTEND_URL ? `${FRONTEND_URL}${path}` : path;
}

function fireEmail(params) {
  notificationService.sendEmail(params).catch(err =>
    logger.error('Erreur email conge', { error: err.message })
  );
}

function safeNumber(value) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function buildDateKey(dateValue) {
  return dayjs(dateValue).format('YYYY-MM-DD');
}

// Construit un objet de lookup à partir du tableau brut de JoursFeries.
// Les fériés récurrents sont indexés par 'MM-DD' (comparaison mois/jour uniquement).
// Les fériés non récurrents sont indexés par 'YYYY-MM-DD' (année exacte).
// Les fériés est_travail=true sont exclus : le salarié travaille ce jour-là.
function buildJoursFeriesLookup(joursFeries) {
  const exactSet = new Set();
  const recurrentSet = new Set();
  for (const jf of joursFeries || []) {
    if (jf.est_travail) continue;
    const d = dayjs(jf.date);
    if (jf.recurrent) {
      recurrentSet.add(d.format('MM-DD'));
    } else {
      exactSet.add(d.format('YYYY-MM-DD'));
    }
  }
  return { exactSet, recurrentSet };
}

const EMPTY_FERIES_LOOKUP = { exactSet: new Set(), recurrentSet: new Set() };

function shouldCountLeaveDay(current, joursFeriesLookup, blockedDays) {
  const day = current.day();
  const dateKey = current.format('YYYY-MM-DD');
  const weekdaysSet = new Set(Array.isArray(blockedDays?.weekdays) ? blockedDays.weekdays : []);
  const excludeWeekends = blockedDays?.exclude_weekends !== false;
  const countSaturday = blockedDays?.count_saturday === true;
  const countSunday = blockedDays?.count_sunday === true;
  const excludeHolidays = blockedDays?.exclude_holidays !== false;
  const specificDatesSet = new Set(Array.isArray(blockedDays?.specific_dates) ? blockedDays.specific_dates : []);

  if (excludeWeekends && ((day === 6 && !countSaturday) || (day === 0 && !countSunday))) {
    return false;
  }

  if (weekdaysSet.has(day)) {
    return false;
  }

  if (specificDatesSet.has(dateKey)) {
    return false;
  }

  if (excludeHolidays) {
    const monthDay = current.format('MM-DD');
    const lookup = joursFeriesLookup || EMPTY_FERIES_LOOKUP;
    if (lookup.exactSet.has(dateKey) || lookup.recurrentSet.has(monthDay)) {
      return false;
    }
  }

  return true;
}

function getExtraWeekendDaysAfterFriday(endDate, blockedDays) {
  if (!endDate || typeof endDate.day !== 'function') return 0;
  if (endDate.day() !== 5) return 0;

  const addSaturday = blockedDays?.include_saturday_after_friday === true;
  const addSunday = blockedDays?.include_sunday_after_friday === true;

  return (addSaturday ? 1 : 0) + (addSunday ? 1 : 0);
}

function calculateBusinessDays(conge, joursFeriesLookup, blockedDays) {
  let total = 0;
  let current = dayjs(conge.date_debut);
  const end = dayjs(conge.date_fin);

  while (current.isSameOrBefore(end, 'day')) {
    if (shouldCountLeaveDay(current, joursFeriesLookup, blockedDays)) {
      total += 1;
    }

    current = current.add(1, 'day');
  }

  if (total > 0) {
    if (conge.debut_demi_journee === 'apres_midi') total -= 0.5;
    if (conge.fin_demi_journee === 'matin') total -= 0.5;
  }

  total += getExtraWeekendDaysAfterFriday(end, blockedDays);

  return total;
}

function calculateLeaveBreakdown(conge, joursFeriesLookup, blockedDays) {
  let joursDansPeriode = 0;
  let joursBloques = 0;
  let joursFeriesExclus = 0;
  let joursPrisCalcules = 0;
  const datesNonPrises = [];
  let current = dayjs(conge.date_debut);
  const end = dayjs(conge.date_fin);

  const feriesLookup = joursFeriesLookup || EMPTY_FERIES_LOOKUP;
  const weekdaysSet = new Set(Array.isArray(blockedDays?.weekdays) ? blockedDays.weekdays : []);
  const excludeWeekends = blockedDays?.exclude_weekends !== false;
  const countSaturday = blockedDays?.count_saturday === true;
  const countSunday = blockedDays?.count_sunday === true;
  const excludeHolidays = blockedDays?.exclude_holidays !== false;
  const specificDatesSet = new Set(Array.isArray(blockedDays?.specific_dates) ? blockedDays.specific_dates : []);
  const weekdayLabelByNumber = {
    0: 'Dimanche',
    1: 'Lundi',
    2: 'Mardi',
    3: 'Mercredi',
    4: 'Jeudi',
    5: 'Vendredi',
    6: 'Samedi',
  };

  while (current.isSameOrBefore(end, 'day')) {
    joursDansPeriode += 1;
    const day = current.day();
    const dateKey = current.format('YYYY-MM-DD');
    const monthDay = current.format('MM-DD');

    let blockedCause = null;
    if (excludeWeekends && day === 6 && !countSaturday) {
      blockedCause = 'Week-end (samedi exclu)';
    } else if (excludeWeekends && day === 0 && !countSunday) {
      blockedCause = 'Week-end (dimanche exclu)';
    } else if (weekdaysSet.has(day)) {
      blockedCause = `Jour bloqué (${weekdayLabelByNumber[day] || 'jour configuré'})`;
    } else if (specificDatesSet.has(dateKey)) {
      blockedCause = 'Date bloquée manuellement';
    }

    const isBlocked = Boolean(blockedCause);

    if (isBlocked) {
      joursBloques += 1;
      datesNonPrises.push({
        date: dateKey,
        cause: blockedCause,
        quantite: 1,
      });
    } else if (excludeHolidays && (feriesLookup.exactSet.has(dateKey) || feriesLookup.recurrentSet.has(monthDay))) {
      joursFeriesExclus += 1;
      datesNonPrises.push({
        date: dateKey,
        cause: 'Jour férié exclu',
        quantite: 1,
      });
    } else {
      joursPrisCalcules += 1;
    }

    current = current.add(1, 'day');
  }

  let joursDemiJourneesDeduites = 0;
  if (joursPrisCalcules > 0) {
    if (conge.debut_demi_journee === 'apres_midi') {
      joursPrisCalcules -= 0.5;
      joursDemiJourneesDeduites += 0.5;
      datesNonPrises.push({
        date: dayjs(conge.date_debut).format('YYYY-MM-DD'),
        cause: 'Demi-journée non prise (matin)',
        quantite: 0.5,
      });
    }
    if (conge.fin_demi_journee === 'matin') {
      joursPrisCalcules -= 0.5;
      joursDemiJourneesDeduites += 0.5;
      datesNonPrises.push({
        date: dayjs(conge.date_fin).format('YYYY-MM-DD'),
        cause: 'Demi-journée non prise (après-midi)',
        quantite: 0.5,
      });
    }
  }

  const weekendAfterFridayCount = getExtraWeekendDaysAfterFriday(end, blockedDays);
  joursPrisCalcules += weekendAfterFridayCount;

  const joursDeduitsCalcul = (joursBloques + joursFeriesExclus + joursDemiJourneesDeduites);

  return {
    jours_dans_periode: joursDansPeriode,
    jours_bloques: joursBloques,
    jours_feries_exclus: joursFeriesExclus,
    jours_demi_journees_deduites: joursDemiJourneesDeduites,
    jours_weekend_apres_vendredi: weekendAfterFridayCount,
    jours_deduits_calcul: joursDeduitsCalcul,
    jours_pris_calcules: joursPrisCalcules,
    dates_non_prises: datesNonPrises,
  };
}

async function resolveCongeDays(conge) {
  const persisted = Number.parseFloat(conge.jours_calcules);
  if (Number.isFinite(persisted) && persisted > 0) {
    return persisted;
  }

  // Compat legacy: certains enregistrements peuvent exposer le nombre de jours
  // sous d'autres clés selon l'historique des migrations.
  const fallbackStored = Number.parseFloat(conge.nombre_jours ?? conge.jours_pris);
  if (Number.isFinite(fallbackStored) && fallbackStored > 0) {
    return fallbackStored;
  }

  const computed = await calcJoursConges(
    conge.entreprise_id,
    conge.date_debut,
    conge.date_fin,
    conge.debut_demi_journee,
    conge.fin_demi_journee
  );

  return Number.isFinite(computed) ? computed : 0;
}

async function getEntrepriseLeaveRules(entrepriseId, transaction = null) {
  const entreprise = await Entreprise.findByPk(entrepriseId, {
    attributes: ['id', 'politique_conges'],
    transaction,
  });

  if (!entreprise) {
    throw new Error('Entreprise introuvable');
  }

  return getLeaveRules(entreprise);
}

async function computeOverlapContext({ entrepriseId, utilisateurId, dateDebut, dateFin, userService = null, transaction = null, excludeCongeId = null }) {
  const where = {
    entreprise_id: entrepriseId,
    statut: { [Op.in]: ['reserve', 'en_attente_manager', 'valide_manager', 'valide_final'] },
    date_debut: { [Op.lte]: dateFin },
    date_fin: { [Op.gte]: dateDebut }
  };

  if (excludeCongeId) {
    where.id = { [Op.ne]: excludeCongeId };
  }

  const overlappingConges = await Conge.findAll({
    where,
    include: [{
      model: Utilisateur,
      as: 'utilisateur',
      attributes: ['id', 'service'],
      required: false,
    }],
    attributes: ['id', 'utilisateur_id', 'date_debut', 'date_fin'],
    transaction,
  });

  const overlapWithSameUser = overlappingConges.some((c) => c.utilisateur_id === utilisateurId);
  const distinctUsers = new Set(overlappingConges.map((c) => c.utilisateur_id));
  const sameServiceUsers = userService
    ? new Set(
      overlappingConges
        .filter((c) => c.utilisateur?.service && c.utilisateur.service === userService)
        .map((c) => c.utilisateur_id)
    )
    : new Set();

  return {
    overlapWithSameUser,
    overlappingCount: distinctUsers.size,
    overlappingCountByService: sameServiceUsers.size,
    overlappingConges,
  };
}

function computeConflictPeriod(overlappingConges, userService, requestedStart, requestedEnd) {
  const relevant = userService
    ? overlappingConges.filter((c) => c.utilisateur?.service === userService)
    : overlappingConges;
  if (!relevant.length) return null;

  let conflictStart = requestedEnd;
  let conflictEnd = requestedStart;
  for (const leave of relevant) {
    const intStart = leave.date_debut > requestedStart ? leave.date_debut : requestedStart;
    const intEnd = leave.date_fin < requestedEnd ? leave.date_fin : requestedEnd;
    if (intStart <= intEnd) {
      if (intStart < conflictStart) conflictStart = intStart;
      if (intEnd > conflictEnd) conflictEnd = intEnd;
    }
  }
  return conflictStart <= conflictEnd ? { start: conflictStart, end: conflictEnd } : null;
}

function buildOverlapMessage({ overlapWithSameUser, serviceLimitReached, userService, projectedServiceOnLeaveCount, serviceLimit, conflictPeriod }) {
  if (overlapWithSameUser) {
    return 'Chevauchement : vous avez déjà un congé sur cette période';
  }
  if (serviceLimitReached) {
    const where = conflictPeriod
      ? ` du ${formatDateFR(conflictPeriod.start)} au ${formatDateFR(conflictPeriod.end)}`
      : '';
    return `Le service "${userService || 'votre service'}" atteint sa capacité maximale (${projectedServiceOnLeaveCount}/${serviceLimit} absences simultanées)${where}`;
  }
  return null;
}

async function checkOverlapConge({ utilisateur_id, conge_type_id, date_debut, date_fin, debut_demi_journee, fin_demi_journee, reqUser }) {
  const utilisateurId = utilisateur_id || reqUser?.id;
  const debutDemiJournee = debut_demi_journee || 'matin';
  const finDemiJournee = fin_demi_journee || 'apres_midi';

  if (!validateUUID(utilisateurId)) throw new Error('utilisateur_id invalide');
  if (!validateUUID(conge_type_id)) throw new Error('conge_type_id invalide');
  if (!validateDateRange(date_debut, date_fin)) throw new Error('Dates invalides ou date_fin < date_debut');
  if (!validateDemiJournee(debutDemiJournee)) throw new Error('debut_demi_journee invalide');
  if (!validateDemiJournee(finDemiJournee)) throw new Error('fin_demi_journee invalide');
  if (date_debut === date_fin && debutDemiJournee === 'apres_midi' && finDemiJournee === 'matin') {
    throw new Error('Demi-journée incohérente sur une seule journée');
  }

  const utilisateur = await Utilisateur.findByPk(utilisateurId);
  if (!utilisateur) throw new Error('Utilisateur introuvable');

  if (!['employe', 'apprenti', 'manager'].includes(reqUser?.role)) {
    throw new Error('Seuls les employés et managers peuvent poser un congé');
  }

  if (reqUser.id !== utilisateur.id) {
    throw new Error('Un employé ou un manager ne peut créer un congé que pour lui-même');
  }

  if (reqUser?.role !== 'super_admin' && reqUser?.entreprise_id !== utilisateur.entreprise_id) {
    throw new Error('Accès interdit: entreprise différente');
  }

  const congeType = await CongeType.findByPk(conge_type_id);
  if (!congeType) throw new Error('Type de congé invalide');
  if (congeType.entreprise_id !== utilisateur.entreprise_id) {
    throw new Error('Le type de congé ne correspond pas à l entreprise de l utilisateur');
  }
  if (!congeType.demi_journee_autorisee && (debutDemiJournee === 'apres_midi' || finDemiJournee === 'matin')) {
    throw Object.assign(new Error('Les demi-journées ne sont pas autorisées pour ce type de congé'), { status: 422 });
  }

  const baseLeaveRules = await getEntrepriseLeaveRules(utilisateur.entreprise_id);
  const leaveRules = getEffectiveLeaveRules(baseLeaveRules, utilisateur.service || null);

  const overlapContext = await computeOverlapContext({
    entrepriseId: utilisateur.entreprise_id,
    utilisateurId,
    dateDebut: date_debut,
    dateFin: date_fin,
    userService: utilisateur.service || null,
  });

  const userService = utilisateur.service || null;
  const serviceLimit = Number(userService ? leaveRules.max_employees_on_leave.by_service?.[userService] : null);
  const projectedServiceOnLeaveCount = overlapContext.overlappingCountByService + 1;
  const serviceLimitReached = Boolean(
    userService && Number.isFinite(serviceLimit) && serviceLimit > 0 && projectedServiceOnLeaveCount > serviceLimit
  );

  if (overlapContext.overlapWithSameUser || serviceLimitReached) {
    const conflictPeriod = serviceLimitReached
      ? computeConflictPeriod(overlapContext.overlappingConges, userService, date_debut, date_fin)
      : null;
    const message = buildOverlapMessage({
      overlapWithSameUser: overlapContext.overlapWithSameUser,
      serviceLimitReached,
      userService,
      projectedServiceOnLeaveCount,
      serviceLimit,
      conflictPeriod,
    });
    const behavior = overlapContext.overlapWithSameUser ? 'block' : (leaveRules.overlap_behavior || 'block');
    return {
      action: behavior,
      message: message || 'Capacité du service atteinte pour cette période.',
      overlapWithSameUser: overlapContext.overlapWithSameUser,
      serviceLimitReached,
      projectedServiceOnLeaveCount,
      serviceLimit: Number.isFinite(serviceLimit) ? serviceLimit : null,
      userService,
      conflictPeriod,
    };
  }

  return {
    action: 'allow',
    message: null,
    overlapWithSameUser: false,
    serviceLimitReached: false,
    projectedServiceOnLeaveCount,
    serviceLimit: Number.isFinite(serviceLimit) ? serviceLimit : null,
    userService,
  };
}

async function getValidationOverlapStatus(congeId, reqUser) {
  const conge = await Conge.findByPk(congeId);
  if (!conge) throw new Error('Congé introuvable');

  if (reqUser?.role === 'manager' && reqUser?.entreprise_id !== conge.entreprise_id) {
    throw new Error('Accès interdit: entreprise différente');
  }

  if ((reqUser?.role === 'admin_entreprise' || reqUser?.role === 'super_admin')
    && reqUser?.role !== 'super_admin'
    && reqUser?.entreprise_id !== conge.entreprise_id) {
    throw new Error('Accès interdit: entreprise différente');
  }

  const utilisateur = await Utilisateur.findByPk(conge.utilisateur_id);
  if (!utilisateur) throw new Error('Utilisateur introuvable');

  const baseLeaveRules = await getEntrepriseLeaveRules(conge.entreprise_id);
  const leaveRules = getEffectiveLeaveRules(baseLeaveRules, utilisateur.service || null);

  const overlapContext = await computeOverlapContext({
    entrepriseId: conge.entreprise_id,
    utilisateurId: conge.utilisateur_id,
    dateDebut: conge.date_debut,
    dateFin: conge.date_fin,
    userService: utilisateur.service || null,
    excludeCongeId: conge.id,
  });

  const userService = utilisateur.service || null;
  const serviceLimit = Number(userService ? leaveRules.max_employees_on_leave.by_service?.[userService] : null);
  const projectedServiceOnLeaveCount = overlapContext.overlappingCountByService + 1;
  const serviceLimitReached = Boolean(
    userService && Number.isFinite(serviceLimit) && serviceLimit > 0 && projectedServiceOnLeaveCount > serviceLimit
  );

  const hasOverlap = Boolean(overlapContext.overlapWithSameUser || serviceLimitReached);
  const conflictPeriod = serviceLimitReached
    ? computeConflictPeriod(overlapContext.overlappingConges, userService, conge.date_debut, conge.date_fin)
    : null;

  return {
    conge_id: conge.id,
    has_overlap: hasOverlap,
    overlap_with_same_user: overlapContext.overlapWithSameUser,
    service_limit_reached: serviceLimitReached,
    conflict_period: conflictPeriod,
    message: hasOverlap
      ? buildOverlapMessage({
        overlapWithSameUser: overlapContext.overlapWithSameUser,
        serviceLimitReached,
        userService,
        projectedServiceOnLeaveCount,
        serviceLimit,
        conflictPeriod,
      })
      : 'Aucun chevauchement détecté pour cette validation.',
    requires_manager_comment: Boolean(reqUser?.role === 'manager' && hasOverlap),
  };
}

// ----------------------------
// Calcul des jours ouvrés
// ----------------------------
async function calcJoursConges(entrepriseId, dateDebut, dateFin, debut_demi, fin_demi, transaction = null) {
  let total = 0;
  let current = dayjs(dateDebut);
  const end = dayjs(dateFin);
  const leaveRules = await getEntrepriseLeaveRules(entrepriseId, transaction);
  const blockedDays = leaveRules.blocked_days || {};

  // Récupérer les jours fériés de l'entreprise
  const joursFeries = await joursFeriesService.getJoursFeriesEntreprise(entrepriseId);
  const joursFeriesLookup = buildJoursFeriesLookup(joursFeries);

  while (current.isSameOrBefore(end, 'day')) {
    if (shouldCountLeaveDay(current, joursFeriesLookup, blockedDays)) {
      total++;
    }
    current = current.add(1,'day');
  }

  if (total > 0) {
    if (debut_demi === 'apres_midi') total -= 0.5;
    if (fin_demi === 'matin') total -= 0.5;
  }

  total += getExtraWeekendDaysAfterFriday(end, blockedDays);

  return total;
}

// ----------------------------
// Créer un congé
// ----------------------------
async function createConge({ utilisateur_id, conge_type_id, date_debut, date_fin, debut_demi_journee, fin_demi_journee, commentaire_employe, reqUser, req }) {
  const sanitizeHtml = require('sanitize-html');
  const emailQueue = [];
  const congeResult = await sequelize.transaction(async (t) => {
    const utilisateurId = utilisateur_id || reqUser?.id;
    const debutDemiJournee = debut_demi_journee || 'matin';
    const finDemiJournee = fin_demi_journee || 'apres_midi';

    if (!validateUUID(utilisateurId)) throw new Error('utilisateur_id invalide');
    if (!validateUUID(conge_type_id)) throw new Error('conge_type_id invalide');
    if (!validateDateRange(date_debut, date_fin)) throw new Error('Dates invalides ou date_fin < date_debut');
    if (!validateDemiJournee(debutDemiJournee)) throw new Error('debut_demi_journee invalide');
    if (!validateDemiJournee(finDemiJournee)) throw new Error('fin_demi_journee invalide');
    if (date_debut === date_fin && debutDemiJournee === 'apres_midi' && finDemiJournee === 'matin') {
      throw new Error('Demi-journée incohérente sur une seule journée');
    }

    const utilisateur = await Utilisateur.findByPk(utilisateurId, { transaction: t });
    if (!utilisateur) throw new Error('Utilisateur introuvable');

    if (!['employe', 'apprenti', 'manager'].includes(reqUser?.role)) {
      throw new Error('Seuls les employés et managers peuvent poser un congé');
    }

    if (reqUser.id !== utilisateur.id) {
      throw new Error('Un employé ou un manager ne peut créer un congé que pour lui-même');
    }

    if (reqUser?.role !== 'super_admin' && reqUser?.entreprise_id !== utilisateur.entreprise_id) {
      throw new Error('Accès interdit: entreprise différente');
    }

    const congeType = await CongeType.findByPk(conge_type_id, { transaction: t });
    if (!congeType) throw new Error('Type de congé invalide');

    if (congeType.entreprise_id !== utilisateur.entreprise_id) {
      throw new Error('Le type de congé ne correspond pas à l\'entreprise de l\'utilisateur');
    }

    if (!congeType.demi_journee_autorisee && (debutDemiJournee === 'apres_midi' || finDemiJournee === 'matin')) {
      throw new Error('Ce type de congé n\'autorise pas les demi-journées');
    }

    const baseLeaveRules = await getEntrepriseLeaveRules(utilisateur.entreprise_id, t);
    const leaveRules = getEffectiveLeaveRules(baseLeaveRules, utilisateur.service || null);

    const daysUntilStart = dayjs(date_debut).startOf('day').diff(dayjs().startOf('day'), 'day');
    const minNoticeDays = Number.isFinite(Number(leaveRules.minimum_notice_days))
      ? Number(leaveRules.minimum_notice_days)
      : 0;
    if (daysUntilStart < minNoticeDays) {
      throw new Error(`Délai minimum non respecté: ${minNoticeDays} jour(s) minimum`);
    }

    // Verrouiller le compteur en premier pour sérialiser les requêtes concurrentes du même utilisateur
    // et garantir que computeOverlapContext voit les congés déjà validés par d'autres transactions
    let compteur = await CompteurConges.findOne({
      where: { utilisateur_id: utilisateurId, conge_type_id, annee: dayjs(date_debut).year() },
      transaction: t,
      lock: t.LOCK.UPDATE
    });
    if (!compteur) {
      compteur = await ensureCounter({
        entrepriseId: utilisateur.entreprise_id,
        utilisateurId,
        congeTypeId: conge_type_id,
        annee: dayjs(date_debut).year(),
        transaction: t,
      });
    }

    // Vérification chevauchement / capacité simultanée selon politique
    const overlapContext = await computeOverlapContext({
      entrepriseId: utilisateur.entreprise_id,
      utilisateurId,
      dateDebut: date_debut,
      dateFin: date_fin,
      userService: utilisateur.service || null,
      transaction: t,
    });

    const userService = utilisateur.service || null;
    const serviceLimitRaw = userService
      ? leaveRules.max_employees_on_leave.by_service?.[userService]
      : null;
    const serviceLimit = Number(serviceLimitRaw);
    const projectedServiceOnLeaveCount = overlapContext.overlappingCountByService + 1;
    const serviceLimitReached = userService && Number.isFinite(serviceLimit) && serviceLimit > 0
      ? projectedServiceOnLeaveCount > serviceLimit
      : false;

    if (overlapContext.overlapWithSameUser) {
      throw new Error('Chevauchement : vous avez déjà un congé sur cette période');
    }

    let overlapWarningPayload = null;
    if (serviceLimitReached) {
      const conflictPeriod = computeConflictPeriod(overlapContext.overlappingConges, userService, date_debut, date_fin);
      const overlapMessage = buildOverlapMessage({
        overlapWithSameUser: false,
        serviceLimitReached: true,
        userService,
        projectedServiceOnLeaveCount,
        serviceLimit,
        conflictPeriod,
      });
      const behavior = leaveRules.overlap_behavior || 'block';
      if (behavior === 'block') {
        throw new Error(overlapMessage || 'Capacité du service atteinte pour cette période');
      }
      overlapWarningPayload = { message: overlapMessage, conflictPeriod };
    }

    const jours = await calcJoursConges(utilisateur.entreprise_id, date_debut, date_fin, debutDemiJournee, finDemiJournee, t);
    if (!Number.isFinite(jours)) throw new Error('Nombre de jours de congé invalide');
    if (jours <= 0) throw new Error('La période sélectionnée ne contient aucun jour ouvrable. Tous les jours sont bloqués, fériés ou exclus par la politique de l\'entreprise.');

    if (jours > leaveRules.max_consecutive_days) {
      throw new Error(`Durée maximale dépassée: ${leaveRules.max_consecutive_days} jour(s) consécutif(s) max`);
    }

    const soldeDisponible = safeNumber(compteur.jours_acquis) - safeNumber(compteur.jours_reserves);
    const soldeInsuffisant = jours > soldeDisponible;

    // Réservation prévisionnelle — uniquement pour l'année N+1, pas N+2 ou au-delà.
    const anneeConge = dayjs(date_debut).year();
    const anneeActuelle = dayjs().year();
    const canReserveWithoutBalance = leaveRules.autoriser_reservation_sans_solde !== false;
    const isNextYear = anneeConge === anneeActuelle + 1;
    const isReservation = soldeInsuffisant && isNextYear && canReserveWithoutBalance;

    if (soldeInsuffisant && !isReservation) {
      if (anneeConge > anneeActuelle + 1) {
        throw Object.assign(
          new Error(`Les réservations ne sont possibles que pour l'année suivante (${anneeActuelle + 1}). Les congés pour ${anneeConge} ne peuvent pas encore être posés.`),
          { status: 422 }
        );
      }
      if (isNextYear && !canReserveWithoutBalance) {
        throw Object.assign(
          new Error("Réservation anticipée désactivée : votre entreprise n'autorise pas la réservation de congés N+1 sans solde suffisant."),
          { status: 422 }
        );
      }
      throw new Error('Solde insuffisant');
    }

    const approvalWorkflow = leaveRules.approval_workflow;
    // Un manager ne peut pas valider son propre congé : on saute l'étape manager
    const isManagerOwnLeave = reqUser.role === 'manager' && reqUser.id === utilisateurId;
    let statutConge;
    if (isReservation) {
      statutConge = 'reserve';
      compteur.jours_reserves = safeNumber(compteur.jours_reserves) + safeNumber(jours);
    } else if (approvalWorkflow === 'auto' || (isManagerOwnLeave && approvalWorkflow === 'manager_only')) {
      // auto OU manager_only sur son propre congé (personne d'autre pour valider)
      statutConge = 'valide_final';
      compteur.jours_acquis = Math.max(0, safeNumber(compteur.jours_acquis) - safeNumber(jours));
      compteur.jours_pris = safeNumber(compteur.jours_pris) + safeNumber(jours);
    } else if (isManagerOwnLeave && approvalWorkflow === 'manager_admin') {
      // manager_admin : saute la validation manager, attend l'admin directement
      statutConge = 'valide_manager';
      compteur.jours_reserves = safeNumber(compteur.jours_reserves) + safeNumber(jours);
    } else {
      statutConge = 'en_attente_manager';
      compteur.jours_reserves = safeNumber(compteur.jours_reserves) + safeNumber(jours);
    }
    await compteur.save({ transaction: t });

    const safeCommentaire = commentaire_employe ? sanitizeHtml(commentaire_employe, { allowedTags: [], allowedAttributes: {} }) : commentaire_employe;
    const conge = await Conge.create({
      utilisateur_id: utilisateurId,
      entreprise_id: utilisateur.entreprise_id,
      conge_type_id,
      date_debut,
      date_fin,
      debut_demi_journee: debutDemiJournee,
      fin_demi_journee: finDemiJournee,
      commentaire_employe: safeCommentaire,
      statut: statutConge,
      jours_calcules: jours
    }, { transaction: t });

    // Mouvement de solde
    await logMouvement({
      entreprise_id: utilisateur.entreprise_id,
      utilisateur_id: utilisateurId,
      conge_type_id,
      annee: anneeConge,
      type: isReservation ? 'reservation' : statutConge === 'valide_final' ? 'validation_auto' : 'reservation',
      quantite: -jours,
      solde_apres: safeNumber(compteur.jours_acquis) - safeNumber(compteur.jours_reserves),
      source_id: conge.id,
      description: descriptionConge(
        isReservation ? 'Réservation N+1' : statutConge === 'valide_final' ? 'Congé validé (auto)' : 'Congé posé (en attente)',
        date_debut, date_fin
      ),
      transaction: t,
    });

    // Notification à tous les managers et à l'admin entreprise
    const managers = await Utilisateur.findAll({
      where: { entreprise_id: utilisateur.entreprise_id, role: 'manager', statut: 'actif' }
    });
    const admin = await Utilisateur.findOne({
      where: { entreprise_id: utilisateur.entreprise_id, role: 'admin_entreprise' }
    });

    const shouldNotifyOnCreate = leaveRules.notification_settings.on_create;

    const utilisateurNomComplet = `${utilisateur.prenom || ''} ${utilisateur.nom || ''}`.trim() || utilisateur.nom;

    if (shouldNotifyOnCreate && !isReservation && managers.length > 0) {
      for (const manager of managers) {
        emailQueue.push({
          to: manager.email,
          subject: `Nouvelle demande de conge - ${utilisateurNomComplet}`,
          templateName: 'leave-new-request-manager',
          data: {
            destinataire_prenom: manager.prenom || 'Manager',
            demandeur_nom: utilisateurNomComplet,
            date_debut: formatDateFR(date_debut),
            date_fin: formatDateFR(date_fin),
            type_conge: congeType.libelle || 'Type non renseigne',
            commentaire_employe: safeCommentaire || 'Aucun',
            overlap_warning_html: overlapWarningPayload
              ? `<div style="margin-top:12px;padding:12px;border:1px solid #f59e0b;background:#fffbeb;border-radius:8px;color:#92400e;"><strong>⚠ Alerte chevauchement :</strong><br/>${overlapWarningPayload.message}</div>`
              : '',
            action_url: buildCongeUrl(conge.id),
          }
        });
        await notificationService.creerNotification({
          entreprise_id: utilisateur.entreprise_id,
          utilisateur_id: manager.id,
          type: 'conge_demande',
          message: `Nouvelle demande de congé de ${utilisateurNomComplet} (${formatDateFR(date_debut)} - ${formatDateFR(date_fin)})`,
          url: `/conges/${conge.id}`,
          transaction: t
        });
      }
    }

    if (shouldNotifyOnCreate && !isReservation && admin) {
      emailQueue.push({
        to: admin.email,
        subject: `Nouvelle demande de conge - ${utilisateurNomComplet}`,
        templateName: 'leave-new-request-manager',
        data: {
          destinataire_prenom: admin.prenom || 'Administrateur',
          demandeur_nom: utilisateurNomComplet,
          date_debut: formatDateFR(date_debut),
          date_fin: formatDateFR(date_fin),
          type_conge: congeType.libelle || 'Type non renseigne',
          commentaire_employe: safeCommentaire || 'Aucun',
          overlap_warning_html: overlapWarningPayload
            ? `<div style="margin-top:12px;padding:12px;border:1px solid #f59e0b;background:#fffbeb;border-radius:8px;color:#92400e;"><strong>⚠ Alerte chevauchement :</strong><br/>${overlapWarningPayload.message}</div>`
            : '',
          action_url: buildCongeUrl(conge.id),
        }
      });
      await notificationService.creerNotification({
        entreprise_id: utilisateur.entreprise_id,
        utilisateur_id: admin.id,
        type: 'conge_demande',
        message: `Nouvelle demande de congé de ${utilisateurNomComplet} (${formatDateFR(date_debut)} - ${formatDateFR(date_fin)})`,
        url: `/conges/${conge.id}`,
        transaction: t
      });
    }

    // Notification à l'employé : congé créé ou réservé
    if (shouldNotifyOnCreate) {
      if (isReservation) {
        emailQueue.push({
          to: utilisateur.email,
          subject: 'Réservation de congé enregistrée',
          templateName: 'leave-reservation-employee',
          data: {
            destinataire_prenom: utilisateur.prenom || 'Collaborateur',
            date_debut: formatDateFR(date_debut),
            date_fin: formatDateFR(date_fin),
            type_conge: congeType.libelle || 'Congé',
            jours_calcules: jours,
            action_url: buildCongeUrl(conge.id),
          }
        });
        await notificationService.creerNotification({
          entreprise_id: utilisateur.entreprise_id,
          utilisateur_id: utilisateur.id,
          type: 'conge_cree',
          message: `Votre réservation de congé du ${formatDateFR(date_debut)} au ${formatDateFR(date_fin)} a été enregistrée (solde insuffisant pour l'année en cours).`,
          url: `/conges/${conge.id}`,
          transaction: t
        });
        // Notifier aussi admins et managers de la réservation
        const allRecipients = [...managers, ...(admin ? [admin] : [])];
        for (const recipient of allRecipients) {
          emailQueue.push({
            to: recipient.email,
            subject: `Réservation de congé - ${utilisateurNomComplet}`,
            templateName: 'leave-reservation-admin',
            data: {
              destinataire_prenom: recipient.prenom || 'Responsable',
              demandeur_nom: utilisateurNomComplet,
              date_debut: formatDateFR(date_debut),
              date_fin: formatDateFR(date_fin),
              type_conge: congeType.libelle || 'Congé',
              jours_calcules: jours,
              action_url: buildCongeUrl(conge.id),
            }
          });
        }
      } else {
        emailQueue.push({
          to: utilisateur.email,
          subject: 'Confirmation de creation de votre demande de conge',
          templateName: 'leave-created-employee',
          data: {
            destinataire_prenom: utilisateur.prenom || 'Collaborateur',
            date_debut: formatDateFR(date_debut),
            date_fin: formatDateFR(date_fin),
            statut_label: approvalWorkflow === 'auto' ? 'Validee automatiquement' : 'En attente de validation',
            overlap_warning_html: '',
            action_url: buildCongeUrl(conge.id),
          }
        });
        await notificationService.creerNotification({
          entreprise_id: utilisateur.entreprise_id,
          utilisateur_id: utilisateur.id,
          type: 'conge_cree',
          message: `Votre congé du ${formatDateFR(date_debut)} au ${formatDateFR(date_fin)} ${approvalWorkflow === 'auto' ? 'a été validé automatiquement' : 'est en attente de validation'}`,
          url: `/conges/${conge.id}`,
          transaction: t
        });
      }
    }

    if (overlapWarningPayload) {
      await notificationService.creerNotification({
        entreprise_id: utilisateur.entreprise_id,
        utilisateur_id: reqUser.id,
        type: 'conge_conflit_warning',
        message: overlapWarningPayload.message,
        url: `/conges/${conge.id}`,
        transaction: t
      });
    }

    // Audit
    await auditConge.created(conge, reqUser, req || null);

    const congeResponse = conge.toJSON();
    if (overlapWarningPayload) congeResponse.overlap_warning = overlapWarningPayload;
    return congeResponse;
  });
  emailQueue.forEach(payload => fireEmail(payload));
  return congeResult;
}

// ----------------------------
// Valider un congé
// ----------------------------
async function validerConge(congeId, reqUser, commentaire = null, req = null) {
  const emailQueue = [];
  const conge = await sequelize.transaction(async (t) => {
    const conge = await Conge.findByPk(congeId, { transaction: t, lock: t.LOCK.UPDATE });
    if (!conge) throw new Error('Congé introuvable');
    if (reqUser.entreprise_id !== conge.entreprise_id) throw new Error('Accès interdit');

    // Verrou consultatif PostgreSQL (advisory) par entreprise : sérialise les
    // validations concurrentes sans bloquer d'autres opérations sur la même ligne.
    // Transaction-scoped : libéré automatiquement au commit/rollback.
    {
      const crypto = require('crypto');
      const hash = crypto.createHash('sha256').update(conge.entreprise_id).digest();
      const k1 = hash.readInt32BE(0);
      const k2 = hash.readInt32BE(4);
      await sequelize.query(
        `SELECT pg_advisory_xact_lock(${k1}, ${k2})`,
        { transaction: t }
      );
    }

    const joursConge = await resolveCongeDays(conge);
    const baseLeaveRules = await getEntrepriseLeaveRules(conge.entreprise_id, t);

    const utilisateur = await Utilisateur.findByPk(conge.utilisateur_id, { transaction: t });
    const leaveRules = getEffectiveLeaveRules(baseLeaveRules, utilisateur?.service || null);

    // Résoudre le rôle effectif pour les délégués
    let effectiveRole = reqUser.role;
    if (!['manager', 'admin_entreprise', 'super_admin'].includes(effectiveRole)) {
      const delegatingUser = await Utilisateur.findOne({
        where: {
          entreprise_id: conge.entreprise_id,
          delegue_id: reqUser.id,
          role: { [Op.in]: ['manager', 'admin_entreprise'] },
          statut: 'actif',
        },
        transaction: t,
      });
      if (delegatingUser) effectiveRole = delegatingUser.role;
    }

    if (effectiveRole === 'manager') {
      if (reqUser.id === conge.utilisateur_id) {
        throw new Error('Un manager ne peut pas valider son propre congé');
      }

      if (leaveRules.approval_workflow === 'auto') {
        throw new Error('Workflow auto: aucune validation manuelle nécessaire');
      }

      if (leaveRules.approval_workflow === 'admin_only') {
        throw new Error('Workflow admin_only: validation par administrateur uniquement');
      }

      if (conge.statut !== 'en_attente_manager') {
        throw new Error('Impossible de valider ce congé à ce stade');
      }

      const managerComment = typeof commentaire === 'string' ? commentaire.trim() : null;

      const overlapContext = await computeOverlapContext({
        entrepriseId: conge.entreprise_id,
        utilisateurId: conge.utilisateur_id,
        dateDebut: conge.date_debut,
        dateFin: conge.date_fin,
        userService: utilisateur?.service || null,
        transaction: t,
        excludeCongeId: conge.id,
      });

      const userService = utilisateur?.service || null;
      const serviceLimitRaw = userService
        ? leaveRules.max_employees_on_leave.by_service?.[userService]
        : null;
      const serviceLimit = Number(serviceLimitRaw);
      const projectedServiceOnLeaveCount = overlapContext.overlappingCountByService + 1;
      const serviceLimitReached = Boolean(
        userService && Number.isFinite(serviceLimit) && serviceLimit > 0 && projectedServiceOnLeaveCount > serviceLimit
      );

      const hasOverlapAtValidation = Boolean(
        overlapContext.overlapWithSameUser || serviceLimitReached
      );

      const conflictPeriodValidation = serviceLimitReached
        ? computeConflictPeriod(overlapContext.overlappingConges, userService, conge.date_debut, conge.date_fin)
        : null;
      const overlapMessage = hasOverlapAtValidation
        ? buildOverlapMessage({
          overlapWithSameUser: overlapContext.overlapWithSameUser,
          serviceLimitReached,
          userService,
          projectedServiceOnLeaveCount,
          serviceLimit,
          conflictPeriod: conflictPeriodValidation,
        })
        : null;

      if (hasOverlapAtValidation && !managerComment) {
        throw new Error('Commentaire manager obligatoire en cas de chevauchement avant validation');
      }

      conge.statut = ['manager', 'manager_only'].includes(leaveRules.approval_workflow)
        ? 'valide_final'
        : 'valide_manager';
      conge.commentaire_manager = managerComment;
      await conge.save({ transaction: t });

      // Notification admin entreprise
      const admin = await Utilisateur.findOne({
        where: { entreprise_id: conge.entreprise_id, role: 'admin_entreprise' }
      });
      const managerNom = `${reqUser?.prenom || ''} ${reqUser?.nom || ''}`.trim() || 'Votre manager';

      if (admin) {
        emailQueue.push({
          to: admin.email,
          subject: hasOverlapAtValidation
            ? 'ALERTE chevauchement - validation finale requise'
            : 'Demande de conge validee par le manager - action requise',
          templateName: 'leave-manager-approved-admin',
          data: {
            destinataire_prenom: admin.prenom || 'Administrateur',
            manager_nom: managerNom,
            demandeur_nom: `${utilisateur.prenom || ''} ${utilisateur.nom || ''}`.trim() || utilisateur.nom,
            date_debut: formatDateFR(conge.date_debut),
            date_fin: formatDateFR(conge.date_fin),
            commentaire_employe: conge.commentaire_employe || 'Aucun',
            commentaire_manager: conge.commentaire_manager || 'Aucun',
            overlap_warning_html: hasOverlapAtValidation
              ? `<div style="margin-top:12px;padding:12px;border:1px solid #f59e0b;background:#fffbeb;border-radius:8px;color:#92400e;"><strong>Alerte chevauchement :</strong><br/>${overlapMessage || 'Chevauchement détecté sur cette demande.'}</div>`
              : '',
            action_url: buildCongeUrl(conge.id),
          }
        });
        await notificationService.creerNotification({
          entreprise_id: conge.entreprise_id,
          utilisateur_id: admin.id,
          type: 'conge_valide_manager',
          message: hasOverlapAtValidation
            ? `ALERTE chevauchement: congé de ${utilisateur.nom} validé par manager (${formatDateFR(conge.date_debut)} - ${formatDateFR(conge.date_fin)})`
            : `Congé de ${utilisateur.nom} validé par manager (${formatDateFR(conge.date_debut)} - ${formatDateFR(conge.date_fin)})`,
          url: `/conges/${conge.id}`,
          transaction: t
        });
      }

      // Notifier l'employé que sa demande est en attente de validation admin (workflow manager_admin)
      if (leaveRules.approval_workflow === 'manager_admin' && leaveRules.notification_settings.on_validate) {
        emailQueue.push({
          to: utilisateur.email,
          subject: 'Votre demande a ete validee par votre manager - validation admin en cours',
          templateName: 'leave-manager-validated-employee',
          data: {
            destinataire_prenom: utilisateur.prenom || 'Collaborateur',
            manager_nom: managerNom,
            type_conge: conge.conge_type?.libelle || 'Congé',
            jours_calcules: conge.jours_calcules || '?',
            date_debut: formatDateFR(conge.date_debut),
            date_fin: formatDateFR(conge.date_fin),
            action_url: buildCongeUrl(conge.id),
          }
        });
      }

      if (['manager', 'manager_only'].includes(leaveRules.approval_workflow)) {
        let compteur = await CompteurConges.findOne({
          where: {
            utilisateur_id: conge.utilisateur_id,
            conge_type_id: conge.conge_type_id,
            annee: dayjs(conge.date_debut).year()
          },
          transaction: t,
          lock: t.LOCK.UPDATE
        });
        if (!compteur) {
          compteur = await ensureCounter({
            entrepriseId: conge.entreprise_id,
            utilisateurId: conge.utilisateur_id,
            congeTypeId: conge.conge_type_id,
            annee: dayjs(conge.date_debut).year(),
            transaction: t,
          });
        }

        compteur.jours_acquis = Math.max(0, safeNumber(compteur.jours_acquis) - safeNumber(joursConge));
        compteur.jours_pris = safeNumber(compteur.jours_pris) + safeNumber(joursConge);
        compteur.jours_reserves = Math.max(0, safeNumber(compteur.jours_reserves) - safeNumber(joursConge));
        await compteur.save({ transaction: t });

        await logMouvement({
          entreprise_id: conge.entreprise_id,
          utilisateur_id: conge.utilisateur_id,
          conge_type_id: conge.conge_type_id,
          annee: dayjs(conge.date_debut).year(),
          type: 'validation',
          quantite: 0,
          solde_apres: safeNumber(compteur.jours_acquis) - safeNumber(compteur.jours_reserves),
          source_id: conge.id,
          description: descriptionConge('Congé validé', conge.date_debut, conge.date_fin),
          transaction: t,
        });

        // Alerte solde faible (< 3 jours restants)
        const soldeRestant = safeNumber(compteur.jours_acquis);
        if (soldeRestant <= 3 && soldeRestant >= 0) {
          emailService.sendLowBalance(
            utilisateur,
            conge.conge_type?.libelle || 'Congé',
            soldeRestant,
            dayjs(conge.date_debut).year()
          ).catch((e) => logger.error('sendLowBalance error', { error: e.message }));
        }

        if (leaveRules.notification_settings.on_validate) {
          emailQueue.push({
            to: utilisateur.email,
            subject: 'Votre demande de conge est approuvee',
            templateName: 'leave-approved-employee',
            data: {
              destinataire_prenom: utilisateur.prenom || 'Collaborateur',
              auteur_action: managerNom,
              type_conge: conge.conge_type?.libelle || 'Congé',
              jours_calcules: conge.jours_calcules || '?',
              date_debut: formatDateFR(conge.date_debut),
              date_fin: formatDateFR(conge.date_fin),
              commentaire: conge.commentaire_manager || conge.commentaire_admin || 'Aucun commentaire',
              action_url: buildCongeUrl(conge.id),
            }
          });
          await notificationService.creerNotification({
            entreprise_id: conge.entreprise_id,
            utilisateur_id: utilisateur.id,
            type: 'conge_valide_final',
            message: `Votre congé du ${formatDateFR(conge.date_debut)} au ${formatDateFR(conge.date_fin)} a été approuvé par ${managerNom}`,
            url: `/conges/${conge.id}`,
            transaction: t
          });
        }
      }

      // Audit
      await auditConge.approved(conge, reqUser, req);
    } else if (effectiveRole === 'admin_entreprise' || effectiveRole === 'super_admin') {
      if (leaveRules.approval_workflow === 'auto') {
        const err = new Error('Workflow auto: aucune validation manuelle nécessaire'); err.statusCode = 400; throw err;
      }

      if (['manager', 'manager_only'].includes(leaveRules.approval_workflow)) {
        const err = new Error('Workflow manager: validation finale par manager uniquement'); err.statusCode = 400; throw err;
      }

      if (leaveRules.approval_workflow === 'manager_admin' && conge.statut !== 'valide_manager') {
        const err = new Error('Le manager doit valider ce congé avant que vous puissiez le valider'); err.statusCode = 400; throw err;
      }

      if (!['en_attente_manager', 'valide_manager'].includes(conge.statut)) {
        const err = new Error('Impossible de valider ce congé à ce stade'); err.statusCode = 400; throw err;
      }

      // Vérification de capacité (absente dans la branche admin avant ce fix).
      // On ne compte que les congés DÉJÀ approuvés (valide_manager / valide_final),
      // pas les en_attente_manager qui pourraient encore être refusés.
      const adminUserService = utilisateur?.service || null;
      const adminServiceLimitRaw = adminUserService
        ? leaveRules.max_employees_on_leave.by_service?.[adminUserService]
        : null;
      const adminServiceLimit = Number(adminServiceLimitRaw);
      const hasCapacityLimit = adminUserService && Number.isFinite(adminServiceLimit) && adminServiceLimit > 0;

      if (hasCapacityLimit) {
        const approvedRows = await Conge.findAll({
          where: {
            entreprise_id: conge.entreprise_id,
            statut: { [Op.in]: ['valide_manager', 'valide_final'] },
            date_debut: { [Op.lte]: conge.date_fin },
            date_fin:   { [Op.gte]: conge.date_debut },
            id: { [Op.ne]: conge.id },
          },
          attributes: ['utilisateur_id'],
          include: [{
            model: Utilisateur, as: 'utilisateur',
            attributes: ['service'], required: false,
          }],
          transaction: t,
        });

        const serviceApproved = adminUserService
          ? new Set(approvedRows
              .filter(r => r.utilisateur?.service === adminUserService)
              .map(r => r.utilisateur_id)).size
          : 0;
        const adminServiceLimitReached = Boolean(
          adminUserService && Number.isFinite(adminServiceLimit) && adminServiceLimit > 0
          && (serviceApproved + 1) > adminServiceLimit
        );

        if (adminServiceLimitReached && leaveRules.overlap_behavior !== 'warning') {
          const err = new Error(
            `Impossible de valider : Capacité service "${adminUserService}" dépassée sur la période ${formatDateFR(conge.date_debut)} – ${formatDateFR(conge.date_fin)}`
          );
          err.statusCode = 409;
          throw err;
        }
      }

      // Vérification de la limite globale (max_employees_on_leave.global)
      const globalLimit = Number(leaveRules.max_employees_on_leave?.global);
      if (Number.isFinite(globalLimit) && globalLimit > 0) {
        const globalRows = await Conge.findAll({
          where: {
            entreprise_id: conge.entreprise_id,
            statut: { [Op.in]: ['valide_manager', 'valide_final'] },
            date_debut: { [Op.lte]: conge.date_fin },
            date_fin:   { [Op.gte]: conge.date_debut },
            id: { [Op.ne]: conge.id },
          },
          attributes: ['utilisateur_id'],
          transaction: t,
        });
        const globalApproved = new Set(globalRows.map(r => r.utilisateur_id)).size;
        if ((globalApproved + 1) > globalLimit && leaveRules.overlap_behavior !== 'warning') {
          const err = new Error(
            `Impossible de valider : Capacité globale (${globalLimit}) dépassée sur la période ${formatDateFR(conge.date_debut)} – ${formatDateFR(conge.date_fin)}`
          );
          err.statusCode = 409;
          throw err;
        }
      }

      // Re-vérification chevauchement même-employé (Fix #29)
      // Cherche un congé déjà valide_final pour le même utilisateur sur la même période.
      // On compare uniquement valide_final car c'est le statut définitif ; un autre
      // valide_manager concurrent sera bloqué à son propre tour de validation admin.
      const selfOverlap = await Conge.findOne({
        where: {
          utilisateur_id: conge.utilisateur_id,
          statut: 'valide_final',
          date_debut: { [Op.lte]: conge.date_fin },
          date_fin:   { [Op.gte]: conge.date_debut },
          id: { [Op.ne]: conge.id },
        },
        attributes: ['id'],
        transaction: t,
      });
      if (selfOverlap) {
        const err = new Error(
          `Validation impossible : ${utilisateur?.prenom || ''} ${utilisateur?.nom || ''} ` +
          `a déjà un congé approuvé sur la période ` +
          `${formatDateFR(conge.date_debut)} – ${formatDateFR(conge.date_fin)}.`
        );
        err.statusCode = 409;
        throw err;
      }

      conge.statut = 'valide_final';
      conge.commentaire_admin = commentaire;
      await conge.save({ transaction: t });

      // Mise à jour compteur
      let compteur = await CompteurConges.findOne({
        where: {
          utilisateur_id: conge.utilisateur_id,
          conge_type_id: conge.conge_type_id,
          annee: dayjs(conge.date_debut).year()
        },
        transaction: t,
        lock: t.LOCK.UPDATE
      });
      if (!compteur) {
        compteur = await ensureCounter({
          entrepriseId: conge.entreprise_id,
          utilisateurId: conge.utilisateur_id,
          congeTypeId: conge.conge_type_id,
          annee: dayjs(conge.date_debut).year(),
          transaction: t,
        });
      }

      compteur.jours_acquis = Math.max(0, safeNumber(compteur.jours_acquis) - safeNumber(joursConge));
      compteur.jours_pris = safeNumber(compteur.jours_pris) + safeNumber(joursConge);
      compteur.jours_reserves = Math.max(0, safeNumber(compteur.jours_reserves) - safeNumber(joursConge));
      await compteur.save({ transaction: t });

      await logMouvement({
        entreprise_id: conge.entreprise_id,
        utilisateur_id: conge.utilisateur_id,
        conge_type_id: conge.conge_type_id,
        annee: dayjs(conge.date_debut).year(),
        type: 'validation',
        quantite: 0,
        solde_apres: safeNumber(compteur.jours_acquis) - safeNumber(compteur.jours_reserves),
        source_id: conge.id,
        description: descriptionConge('Congé validé', conge.date_debut, conge.date_fin),
        transaction: t,
      });

      // Alerte solde faible (≤ 3 jours restants) — symétrique avec la branche manager
      const adminSoldeRestant = safeNumber(compteur.jours_acquis);
      if (adminSoldeRestant <= 3 && adminSoldeRestant >= 0) {
        emailService.sendLowBalance(
          utilisateur,
          conge.conge_type?.libelle || 'Congé',
          adminSoldeRestant,
          dayjs(conge.date_debut).year()
        ).catch((e) => logger.error('sendLowBalance error', { error: e.message }));
      }

      // Notification à l'employé
      if (leaveRules.notification_settings.on_validate) {
        const adminNomValidation = `${reqUser?.prenom || ''} ${reqUser?.nom || ''}`.trim() || 'votre administrateur';
        emailQueue.push({
          to: utilisateur.email,
          subject: 'Votre demande de conge est approuvee',
          templateName: 'leave-approved-employee',
          data: {
            destinataire_prenom: utilisateur.prenom || 'Collaborateur',
            auteur_action: adminNomValidation,
            type_conge: conge.conge_type?.libelle || 'Congé',
            jours_calcules: conge.jours_calcules || '?',
            date_debut: formatDateFR(conge.date_debut),
            date_fin: formatDateFR(conge.date_fin),
            commentaire: conge.commentaire_admin || conge.commentaire_manager || 'Aucun commentaire',
            action_url: buildCongeUrl(conge.id),
          }
        });
        await notificationService.creerNotification({
          entreprise_id: conge.entreprise_id,
          utilisateur_id: utilisateur.id,
          type: 'conge_valide_final',
          message: `Votre congé du ${formatDateFR(conge.date_debut)} au ${formatDateFR(conge.date_fin)} a été approuvé par ${adminNomValidation}`,
          url: `/conges/${conge.id}`,
          transaction: t
        });
      }

      // Audit
      await auditConge.approved(conge, reqUser, req);
    } else {
      throw new Error('Action non autorisée');
    }

    return conge;
  });
  emailQueue.forEach(payload => fireEmail(payload));
  return conge;
}

// ----------------------------
// Refuser un congé
// ----------------------------
async function rejeterConge(congeId, reqUser, commentaire = null, req = null) {
  const emailQueue = [];
  const conge = await sequelize.transaction(async (t) => {
    const conge = await Conge.findByPk(congeId, {
      include: [{ model: CongeType, as: 'conge_type' }],
      transaction: t,
      lock: { level: t.LOCK.UPDATE, of: Conge }
    });
    if (!conge) throw new Error('Congé introuvable');
    if (reqUser.entreprise_id !== conge.entreprise_id) throw new Error('Accès interdit');
    const joursConge = await resolveCongeDays(conge);
    const baseLeaveRules = await getEntrepriseLeaveRules(conge.entreprise_id, t);

    const utilisateur = await Utilisateur.findByPk(conge.utilisateur_id, { transaction: t });
    const leaveRules = getEffectiveLeaveRules(baseLeaveRules, utilisateur?.service || null);
    const ancienStatut = conge.statut;

    if (reqUser.role === 'manager') {
      if (leaveRules.approval_workflow === 'admin_only') {
        const err = new Error('Workflow admin_only: refus par administrateur uniquement');
        err.statusCode = 403;
        throw err;
      }
      if (ancienStatut !== 'en_attente_manager') throw new Error('Impossible de refuser ce congé');
      conge.statut = 'refuse_manager';
      conge.commentaire_manager = commentaire;
    } else if (reqUser.role === 'admin_entreprise' || reqUser.role === 'super_admin') {
      if (['manager', 'manager_only'].includes(leaveRules.approval_workflow)) {
        const err = new Error('Workflow manager_only : refus par manager uniquement');
        err.statusCode = 403;
        throw err;
      }
      if (ancienStatut !== 'valide_manager' && ancienStatut !== 'en_attente_manager') throw new Error('Impossible de refuser ce congé');
      conge.statut = 'refuse_final';
      conge.commentaire_admin = commentaire;
    } else {
      throw new Error('Action non autorisée');
    }

    await conge.save({ transaction: t });

    // Mise à jour compteur : rendre les jours disponibles
    const compteur = await CompteurConges.findOne({
      where: {
        utilisateur_id: conge.utilisateur_id,
        conge_type_id: conge.conge_type_id,
        annee: dayjs(conge.date_debut).year()
      },
      transaction: t,
      lock: t.LOCK.UPDATE
    });

    if (compteur) {
      // Fix #49 : jours_annules manquant — le rejet est sémantiquement équivalent à une
      // annulation pour le reporting RH. jours_acquis reste intact (jamais consommé sur
      // un rejet d'en_attente/valide_manager), seules reserves et annules bougent.
      compteur.jours_reserves = Math.max(0, safeNumber(compteur.jours_reserves) - safeNumber(joursConge));
      compteur.jours_annules  = safeNumber(compteur.jours_annules) + safeNumber(joursConge);
      await compteur.save({ transaction: t });

      await logMouvement({
        entreprise_id: conge.entreprise_id,
        utilisateur_id: conge.utilisateur_id,
        conge_type_id: conge.conge_type_id,
        annee: dayjs(conge.date_debut).year(),
        type: 'rejet',
        quantite: +joursConge,
        solde_apres: safeNumber(compteur.jours_acquis) - safeNumber(compteur.jours_reserves),
        source_id: conge.id,
        description: descriptionConge('Congé refusé', conge.date_debut, conge.date_fin),
        transaction: t,
      });
    }

    // Notification à l'employé
    if (leaveRules.notification_settings.on_reject) {
      const auteurRefus = `${reqUser?.prenom || ''} ${reqUser?.nom || ''}`.trim() ||
        (reqUser?.role === 'manager' ? 'votre manager' : 'votre administrateur');
      emailQueue.push({
        to: utilisateur.email,
        subject: 'Votre demande de conge a ete refusee',
        templateName: 'leave-rejected-employee',
        data: {
          destinataire_prenom: utilisateur.prenom || 'Collaborateur',
          auteur_action: auteurRefus,
          type_conge: conge.conge_type?.libelle || 'Congé',
          date_debut: formatDateFR(conge.date_debut),
          date_fin: formatDateFR(conge.date_fin),
          commentaire: commentaire || conge.commentaire_admin || conge.commentaire_manager || 'Aucun commentaire',
          action_url: buildCongeUrl(conge.id),
        }
      });
      await notificationService.creerNotification({
        entreprise_id: conge.entreprise_id,
        utilisateur_id: utilisateur.id,
        type: 'conge_refuse',
        message: `Votre congé du ${formatDateFR(conge.date_debut)} au ${formatDateFR(conge.date_fin)} a été refusé`,
        url: `/conges/${conge.id}`,
        transaction: t
      });
    }

    // Notification aux managers si l'admin refuse un congé déjà validé par le manager
    if (
      (reqUser.role === 'admin_entreprise' || reqUser.role === 'super_admin') &&
      ancienStatut === 'valide_manager'
    ) {
      const adminNomRefus = `${reqUser?.prenom || ''} ${reqUser?.nom || ''}`.trim() || "L'administrateur";
      const employeNomRefus = `${utilisateur?.prenom || ''} ${utilisateur?.nom || ''}`.trim() || 'Un employé';
      const managersToNotify = await Utilisateur.findAll({
        where: { entreprise_id: conge.entreprise_id, role: 'manager', statut: 'actif' },
        attributes: ['id', 'prenom', 'nom', 'email'],
      });
      for (const mgr of managersToNotify) {
        if (mgr.email) {
          emailService.sendLeaveRejectedManagerInfo(mgr, {
            employe_nom: employeNomRefus,
            admin_nom: adminNomRefus,
            type_conge: conge.conge_type?.libelle || 'Congé',
            date_debut: formatDateFR(conge.date_debut),
            date_fin: formatDateFR(conge.date_fin),
            commentaire: commentaire || null,
          }).catch((e) => logger.error('sendLeaveRejectedManagerInfo error', { error: e.message }));
        }
      }
    }

    // Audit
    await auditConge.rejected(conge, reqUser, req);

    return conge;
  });
  emailQueue.forEach(payload => fireEmail(payload));
  return conge;
}

// ----------------------------
// Liste et détails
// ----------------------------
async function getConges(user, query = {}) {
  const where = {};
  if (user.role === 'employe' || user.role === 'apprenti') {
    where.utilisateur_id = user.id;
  } else if (user.role === 'manager' || user.role === 'admin_entreprise') {
    where.entreprise_id = user.entreprise_id;
  }

  // Filtres optionnels
  if (query.statut) where.statut = query.statut;
  if (query.conge_type_id) where.conge_type_id = query.conge_type_id;
  if (query.utilisateur_id && user.role !== 'employe') where.utilisateur_id = query.utilisateur_id;
  if (query.annee) {
    const yr = parseInt(query.annee, 10);
    if (Number.isFinite(yr)) {
      where.date_debut = { [Op.lte]: `${yr}-12-31` };
      where.date_fin   = { [Op.gte]: `${yr}-01-01` };
    }
  }

  const page  = Math.max(parseInt(query.page,  10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || 200, 1), 500);
  const offset = (page - 1) * limit;

  const { count: total, rows: congesRows } = await Conge.findAndCountAll({
    where,
    limit,
    offset,
    include: [
      {
        model: Utilisateur,
        as: 'utilisateur',
        attributes: ['id', 'prenom', 'nom', 'email', 'service']
      },
      {
        model: CongeType,
        as: 'conge_type',
        attributes: ['id', 'libelle']
      },
      {
        model: Entreprise,
        as: 'entreprise',
        attributes: ['id', 'nom']
      }
    ],
    order: [['created_at', 'DESC']]
  });

  if (congesRows.length === 0) {
    return { items: [], total };
  }

  const conges = congesRows;
  const entrepriseIds = [...new Set(conges.map((c) => c.entreprise_id).filter(Boolean))];
  const joursFeriesByEntreprise = new Map();
  const blockedDaysByEntreprise = new Map();
  const leaveRulesByEntreprise = new Map();

  await Promise.all(
    entrepriseIds.map(async (entrepriseId) => {
      try {
        const leaveRules = await getEntrepriseLeaveRules(entrepriseId);
        leaveRulesByEntreprise.set(entrepriseId, leaveRules);
        blockedDaysByEntreprise.set(entrepriseId, leaveRules.blocked_days || {});
        const joursFeries = await joursFeriesService.getJoursFeriesEntreprise(entrepriseId);
        joursFeriesByEntreprise.set(entrepriseId, buildJoursFeriesLookup(joursFeries));
      } catch (_err) {
        leaveRulesByEntreprise.set(entrepriseId, {});
        blockedDaysByEntreprise.set(entrepriseId, {});
        joursFeriesByEntreprise.set(entrepriseId, EMPTY_FERIES_LOOKUP);
      }
    })
  );

  const compteurKeys = [];
  const uniqueCompteurKeys = new Set();

  conges.forEach((conge) => {
    const annee = dayjs(conge.date_debut).year();
    const key = `${conge.utilisateur_id}::${conge.conge_type_id}::${annee}`;
    if (!uniqueCompteurKeys.has(key)) {
      uniqueCompteurKeys.add(key);
      compteurKeys.push({
        utilisateur_id: conge.utilisateur_id,
        conge_type_id: conge.conge_type_id,
        annee
      });
    }
  });

  const compteurs = await CompteurConges.findAll({
    where: {
      [Op.or]: compteurKeys
    },
    attributes: ['utilisateur_id', 'conge_type_id', 'annee', 'jours_acquis', 'jours_reserves']
  });

  const soldeByKey = new Map();
  compteurs.forEach((compteur) => {
    const solde =
      parseFloat(compteur.jours_acquis || 0) -
      parseFloat(compteur.jours_reserves || 0);
    const key = `${compteur.utilisateur_id}::${compteur.conge_type_id}::${compteur.annee}`;
    soldeByKey.set(key, Number.isFinite(solde) ? solde : null);
  });

  const items = conges.map((conge) => {
    const plainConge = conge.toJSON();
    const annee = dayjs(conge.date_debut).year();
    const compteurKey = `${conge.utilisateur_id}::${conge.conge_type_id}::${annee}`;
    const joursFeriesLookup = joursFeriesByEntreprise.get(conge.entreprise_id) || EMPTY_FERIES_LOOKUP;
    const blockedDays = blockedDaysByEntreprise.get(conge.entreprise_id) || {};
    const entrepriseLeaveRules = leaveRulesByEntreprise.get(conge.entreprise_id) || {};
    const effectiveLeaveRules = getEffectiveLeaveRules(entrepriseLeaveRules, plainConge.utilisateur?.service || null);
    const joursPris = Number.parseFloat(plainConge.jours_calcules);
    const joursPrisValue = Number.isFinite(joursPris)
      ? joursPris
      : calculateBusinessDays(conge, joursFeriesLookup, blockedDays);

    return {
      ...plainConge,
      utilisateur_nom: plainConge.utilisateur
        ? `${plainConge.utilisateur.prenom || ''} ${plainConge.utilisateur.nom || ''}`.trim()
        : null,
      entreprise_nom: plainConge.entreprise?.nom || null,
      conge_type_libelle: plainConge.conge_type?.libelle || null,
      effective_approval_workflow: effectiveLeaveRules.approval_workflow || null,
      jours_pris: Number.isFinite(joursPrisValue) ? joursPrisValue : null,
      jours_restants: soldeByKey.has(compteurKey) ? soldeByKey.get(compteurKey) : null,
      date_demande: plainConge.created_at || plainConge.createdAt || null
    };
  });
  return { items, total };
}

async function getCongeById(id, user) {
  const conge = await Conge.findByPk(id, {
    include: [
      {
        model: Utilisateur,
        as: 'utilisateur',
        attributes: ['id', 'prenom', 'nom', 'email', 'service']
      },
      {
        model: CongeType,
        as: 'conge_type',
        attributes: ['id', 'libelle']
      },
      {
        model: Entreprise,
        as: 'entreprise',
        attributes: ['id', 'nom']
      }
    ]
  });
  if (!conge) { const err = new Error('Congé introuvable'); err.status = 404; throw err; }
  if (user.role !== 'super_admin' && user.entreprise_id !== conge.entreprise_id)
    throw new Error('Accès interdit');
  if ((user.role === 'employe' || user.role === 'apprenti') && user.id !== conge.utilisateur_id)
    throw new Error('Accès interdit');

  const annee = dayjs(conge.date_debut).year();
  const compteur = await CompteurConges.findOne({
    where: {
      utilisateur_id: conge.utilisateur_id,
      conge_type_id: conge.conge_type_id,
      annee
    },
    attributes: ['jours_acquis', 'jours_reserves']
  });

  let joursFeriesLookup = EMPTY_FERIES_LOOKUP;
  let blockedDays = {};
  let effectiveApprovalWorkflow = null;
  try {
    const leaveRules = await getEntrepriseLeaveRules(conge.entreprise_id);
    blockedDays = leaveRules.blocked_days || {};
    effectiveApprovalWorkflow = getEffectiveLeaveRules(leaveRules, conge.utilisateur?.service || null)?.approval_workflow || null;
    const joursFeries = await joursFeriesService.getJoursFeriesEntreprise(conge.entreprise_id);
    joursFeriesLookup = buildJoursFeriesLookup(joursFeries);
  } catch (_err) {
    blockedDays = {};
    effectiveApprovalWorkflow = null;
    joursFeriesLookup = EMPTY_FERIES_LOOKUP;
  }

  const plainConge = conge.toJSON();
  const joursPris = Number.parseFloat(plainConge.jours_calcules);
  const leaveBreakdown = calculateLeaveBreakdown(conge, joursFeriesLookup, blockedDays);
  const joursPrisValue = Number.isFinite(joursPris)
    ? joursPris
    : leaveBreakdown.jours_pris_calcules;

  const joursRestants = compteur
    ? parseFloat(compteur.jours_acquis || 0) -
      parseFloat(compteur.jours_reserves || 0)
    : null;

  return {
    ...plainConge,
    utilisateur_nom: plainConge.utilisateur
      ? `${plainConge.utilisateur.prenom || ''} ${plainConge.utilisateur.nom || ''}`.trim()
      : null,
    entreprise_nom: plainConge.entreprise?.nom || null,
    conge_type_libelle: plainConge.conge_type?.libelle || null,
    effective_approval_workflow: effectiveApprovalWorkflow,
    calcul_details: leaveBreakdown,
    jours_pris: Number.isFinite(joursPrisValue) ? joursPrisValue : null,
    jours_restants: Number.isFinite(joursRestants) ? joursRestants : null,
    nombre_jours: Number.isFinite(joursPrisValue) ? joursPrisValue : plainConge.nombre_jours || null,
    date_demande: plainConge.created_at || plainConge.createdAt || null
  };
}

// ----------------------------
// Modifier et supprimer
// ----------------------------
async function updateConge(id, data, user, req = null) {
  const sanitizeHtml = require('sanitize-html');
  return sequelize.transaction(async (t) => {
    const conge = await Conge.findByPk(id, { transaction: t, lock: t.LOCK.UPDATE });
    if (!conge) throw new Error('Congé introuvable');

    const employe = await Utilisateur.findByPk(conge.utilisateur_id, {
      transaction: t,
      attributes: ['id', 'prenom', 'nom', 'email', 'service']
    });
    if (!employe) throw new Error('Employé introuvable');

    // Fix #44 : super_admin omis de la liste → 403 sur updateConge.
    if (!['admin_entreprise', 'super_admin'].includes(user?.role) && user?.id !== conge.utilisateur_id) {
      throw new Error('Modification non autorisée');
    }

    if (user?.role === 'admin_entreprise' && user?.entreprise_id !== conge.entreprise_id) {
      throw new Error('Accès interdit: entreprise différente');
    }

    const isPending = conge.statut === 'en_attente_manager';
    const isFinalValidated = conge.statut === 'valide_final';
    const isManagerValidated = conge.statut === 'valide_manager';
    const isAdminRole = ['admin_entreprise', 'super_admin'].includes(user?.role);
    const previousDateDebut = conge.date_debut;
    const previousDateFin = conge.date_fin;
    const previousCommentaireEmploye = conge.commentaire_employe || '';

    if (!isPending && !isFinalValidated && !(isManagerValidated && isAdminRole)) {
      throw new Error('Modification impossible');
    }

    if (isFinalValidated) {
      const policyValidation = await LeavePolicyService.validateModification({
        entrepriseId: conge.entreprise_id,
        congeStatus: conge.statut,
        congeStartDate: conge.date_debut,
        initiatorRole: user?.role,
      });

      if (!policyValidation?.allowed) {
        const err = new Error(policyValidation.reason || 'Modification non autorisée selon la politique de congés');
        err.statusCode = 403;
        throw err;
      }
    }

    // Certains clients envoient l'objet complet, y compris le statut.
    // Nous ignorons le statut ici (la validation doit passer par /validate).
    if ('statut' in data) {
      if (data.statut !== conge.statut) {
        throw new Error('Modification du statut non autorisée');
      }
      delete data.statut;
    }

    const allowedFields = [
      'date_debut',
      'date_fin',
      'debut_demi_journee',
      'fin_demi_journee',
      'conge_type_id',
      'commentaire_employe'
    ];

    const updates = {};
    for (const field of allowedFields) {
      if (field in data) {
        if (field === 'commentaire_employe' && typeof data[field] === 'string') {
          const sanitized = sanitizeHtml(data[field], { allowedTags: [], allowedAttributes: {} });
          if (['admin_entreprise', 'super_admin'].includes(user?.role)) {
            updates['commentaire_admin'] = sanitized;
          } else if (user?.role === 'manager') {
            updates['commentaire_manager'] = sanitized;
          } else {
            updates['commentaire_employe'] = sanitized;
          }
        } else if (field === 'debut_demi_journee') {
          updates[field] = data[field] || 'matin';
        } else if (field === 'fin_demi_journee') {
          updates[field] = data[field] || 'apres_midi';
        } else {
          updates[field] = data[field];
        }
      }
    }

    const nextDateDebut = updates.date_debut ?? conge.date_debut;
    const nextDateFin = updates.date_fin ?? conge.date_fin;
    let nextDebutDemiJournee = updates.debut_demi_journee ?? conge.debut_demi_journee;
    let nextFinDemiJournee = updates.fin_demi_journee ?? conge.fin_demi_journee;
    const nextCongeTypeId = updates.conge_type_id ?? conge.conge_type_id;

    if (!validateUUID(nextCongeTypeId)) {
      throw new Error('Type de congé invalide');
    }

    if (!validateDateRange(nextDateDebut, nextDateFin)) {
      throw new Error('Dates invalides ou date_fin < date_debut');
    }

    if (!validateDemiJournee(nextDebutDemiJournee) || !validateDemiJournee(nextFinDemiJournee)) {
      throw new Error('Demi-journée invalide');
    }

    if (
      nextDateDebut === nextDateFin
      && nextDebutDemiJournee === 'apres_midi'
      && nextFinDemiJournee === 'matin'
    ) {
      throw new Error('Demi-journée incohérente sur une seule journée');
    }

    // Vérifier le délai de préavis sur les nouvelles dates (employe uniquement)
    if (isPending && user?.role !== 'admin_entreprise' && user?.role !== 'super_admin') {
      const baseLeaveRulesForUpdate = await getEntrepriseLeaveRules(conge.entreprise_id, t);
      const leaveRulesForUpdate = getEffectiveLeaveRules(baseLeaveRulesForUpdate, employe?.service || null);
      const minNotice = Number.isFinite(Number(leaveRulesForUpdate.minimum_notice_days))
        ? Number(leaveRulesForUpdate.minimum_notice_days)
        : 0;
      const daysUntilStart = dayjs(nextDateDebut).startOf('day').diff(dayjs().startOf('day'), 'day');
      if (daysUntilStart < minNotice) {
        throw new Error(`Délai minimum non respecté: ${minNotice} jour(s) minimum`);
      }
    }

    const oldDays = await resolveCongeDays(conge);
    const newDays = await calcJoursConges(
      conge.entreprise_id,
      nextDateDebut,
      nextDateFin,
      nextDebutDemiJournee,
      nextFinDemiJournee,
      t
    );

    if (!Number.isFinite(newDays) || newDays <= 0) {
      throw new Error('Nombre de jours de congé invalide');
    }

    // Vérification chevauchement sur les nouvelles dates.
    // excludeCongeId évite de compter le congé modifié lui-même comme chevauchant.
    {
      const baseRulesOv = await getEntrepriseLeaveRules(conge.entreprise_id, t);
      const leaveRulesOv = getEffectiveLeaveRules(baseRulesOv, employe.service || null);

      // Fix #55 : revérifier max_consecutive_days sur les nouvelles dates,
      // même logique qu'à la création (ligne 685).
      if (newDays > leaveRulesOv.max_consecutive_days) {
        throw new Error(`Durée maximale dépassée: ${leaveRulesOv.max_consecutive_days} jour(s) consécutif(s) max`);
      }

      const uService = employe.service || null;

      const overlapCtx = await computeOverlapContext({
        entrepriseId: conge.entreprise_id,
        utilisateurId: conge.utilisateur_id,
        dateDebut: nextDateDebut,
        dateFin: nextDateFin,
        userService: uService,
        transaction: t,
        excludeCongeId: conge.id,
      });

      if (overlapCtx.overlapWithSameUser) {
        const err = new Error('Modification rejetée : chevauchement avec un autre congé existant.');
        err.statusCode = 409;
        throw err;
      }

      const serviceLimitRawOv = uService
        ? leaveRulesOv.max_employees_on_leave.by_service?.[uService]
        : null;
      const serviceLimitOv = Number(serviceLimitRawOv);
      const projectedServiceOv = overlapCtx.overlappingCountByService + 1;
      const serviceLimitReachedOv = Boolean(
        uService && Number.isFinite(serviceLimitOv) && serviceLimitOv > 0
        && projectedServiceOv > serviceLimitOv
      );

      if (serviceLimitReachedOv && (leaveRulesOv.overlap_behavior || 'block') === 'block') {
        const conflictPeriodOv = computeConflictPeriod(overlapCtx.overlappingConges, uService, nextDateDebut, nextDateFin);
        const msg = buildOverlapMessage({
          overlapWithSameUser: false,
          serviceLimitReached: true,
          userService: uService,
          projectedServiceOnLeaveCount: projectedServiceOv,
          serviceLimit: serviceLimitOv,
          conflictPeriod: conflictPeriodOv,
        });
        const err = new Error(msg || 'Modification rejetée : capacité du service atteinte.');
        err.statusCode = 409;
        throw err;
      }
    }

    const oldYear = dayjs(conge.date_debut).year();
    const nextYear = dayjs(nextDateDebut).year();

    let oldCounter = await CompteurConges.findOne({
      where: {
        utilisateur_id: conge.utilisateur_id,
        conge_type_id: conge.conge_type_id,
        annee: oldYear
      },
      transaction: t,
      lock: t.LOCK.UPDATE
    });

    if (!oldCounter) {
      oldCounter = await ensureCounter({
        entrepriseId: conge.entreprise_id,
        utilisateurId: conge.utilisateur_id,
        congeTypeId: conge.conge_type_id,
        annee: oldYear,
        transaction: t,
      });
    }

    const nextCongeType = await CongeType.findOne({
      where: { id: nextCongeTypeId, entreprise_id: conge.entreprise_id },
      transaction: t
    });
    if (!nextCongeType) throw new Error('Type de congé introuvable');

    if (!nextCongeType.demi_journee_autorisee) {
      // Type doesn't allow half-days: silently normalize stale values to full-day defaults
      // (the type may have been reconfigured after the leave was originally created)
      updates.debut_demi_journee = 'matin';
      updates.fin_demi_journee = 'apres_midi';
      nextDebutDemiJournee = 'matin';
      nextFinDemiJournee = 'apres_midi';
    }

    const sameCounter = conge.conge_type_id === nextCongeTypeId && oldYear === nextYear;

    let nextCounter = oldCounter;
    if (!sameCounter) {
      nextCounter = await CompteurConges.findOne({
        where: {
          utilisateur_id: conge.utilisateur_id,
          conge_type_id: nextCongeTypeId,
          annee: nextYear
        },
        transaction: t,
        lock: t.LOCK.UPDATE
      });

      if (!nextCounter) {
        nextCounter = await ensureCounter({
          entrepriseId: conge.entreprise_id,
          utilisateurId: conge.utilisateur_id,
          congeTypeId: nextCongeTypeId,
          annee: nextYear,
          transaction: t,
        });
      }
    }

    if (isPending || isManagerValidated) {
      const nextCounterAvailable =
        safeNumber(nextCounter.jours_acquis)
        - safeNumber(nextCounter.jours_reserves);

      const effectiveAvailable = sameCounter
        ? nextCounterAvailable + safeNumber(oldDays)
        : nextCounterAvailable;

      if (safeNumber(newDays) > effectiveAvailable) {
        throw new Error('Solde insuffisant');
      }
    }

    if (isPending || isManagerValidated) {
      if (sameCounter) {
        const rawReserves = safeNumber(oldCounter.jours_reserves) - safeNumber(oldDays);
        if (rawReserves < 0) {
          logger.warn(`updateConge: incohérence jours_reserves compteur ${oldCounter.id} (${oldCounter.jours_reserves} < oldDays ${oldDays})`);
        }
        oldCounter.jours_reserves = Math.max(0, rawReserves) + safeNumber(newDays);
        await oldCounter.save({ transaction: t });
      } else {
        const rawReserves = safeNumber(oldCounter.jours_reserves) - safeNumber(oldDays);
        if (rawReserves < 0) {
          logger.warn(`updateConge: incohérence jours_reserves compteur ${oldCounter.id} (${oldCounter.jours_reserves} < oldDays ${oldDays})`);
        }
        oldCounter.jours_reserves = Math.max(0, rawReserves);
        nextCounter.jours_reserves = safeNumber(nextCounter.jours_reserves) + safeNumber(newDays);
        await oldCounter.save({ transaction: t });
        await nextCounter.save({ transaction: t });
      }
    } else {
      // Branche valide_final : vérification explicite du solde avant toute mise à jour.
      // Avant ce fix, Math.max(0, ...) masquait silencieusement tout déficit.
      if (sameCounter) {
        const netChange = safeNumber(newDays) - safeNumber(oldDays);
        if (netChange > 0 && (safeNumber(oldCounter.jours_acquis) - safeNumber(oldCounter.jours_reserves)) < netChange) {
          const deficit = (netChange - (safeNumber(oldCounter.jours_acquis) - safeNumber(oldCounter.jours_reserves))).toFixed(2);
          const err = new Error(`Solde insuffisant pour cette modification : il manque ${deficit} jour(s).`);
          err.statusCode = 409;
          throw err;
        }
        oldCounter.jours_acquis = safeNumber(oldCounter.jours_acquis) + safeNumber(oldDays) - safeNumber(newDays);
        oldCounter.jours_pris = Math.max(0,
          safeNumber(oldCounter.jours_pris) - safeNumber(oldDays) + safeNumber(newDays));
        await oldCounter.save({ transaction: t });
        await logMouvement({
          entreprise_id: conge.entreprise_id,
          utilisateur_id: conge.utilisateur_id,
          conge_type_id: conge.conge_type_id,
          annee: oldYear,
          type: 'ajustement_admin',
          quantite: safeNumber(oldDays) - safeNumber(newDays),
          solde_apres: safeNumber(oldCounter.jours_acquis) - safeNumber(oldCounter.jours_reserves),
          source_id: conge.id,
          description: descriptionConge('Congé modifié (admin)', nextDateDebut, nextDateFin),
          transaction: t,
        });
      } else {
        if (safeNumber(nextCounter.jours_acquis) < safeNumber(newDays)) {
          const deficit = (safeNumber(newDays) - safeNumber(nextCounter.jours_acquis)).toFixed(2);
          const err = new Error(`Solde insuffisant pour cette modification : il manque ${deficit} jour(s) sur le nouveau type/année.`);
          err.statusCode = 409;
          throw err;
        }
        oldCounter.jours_acquis = safeNumber(oldCounter.jours_acquis) + safeNumber(oldDays);
        oldCounter.jours_pris = Math.max(0, safeNumber(oldCounter.jours_pris) - safeNumber(oldDays));
        nextCounter.jours_acquis = safeNumber(nextCounter.jours_acquis) - safeNumber(newDays);
        nextCounter.jours_pris = safeNumber(nextCounter.jours_pris) + safeNumber(newDays);
        await oldCounter.save({ transaction: t });
        await nextCounter.save({ transaction: t });
        await logMouvement({
          entreprise_id: conge.entreprise_id,
          utilisateur_id: conge.utilisateur_id,
          conge_type_id: conge.conge_type_id,
          annee: oldYear,
          type: 'ajustement_admin',
          quantite: safeNumber(oldDays),
          solde_apres: safeNumber(oldCounter.jours_acquis) - safeNumber(oldCounter.jours_reserves),
          source_id: conge.id,
          description: `Congé modifié (admin) · restitution sur ancien type`,
          transaction: t,
        });
        await logMouvement({
          entreprise_id: conge.entreprise_id,
          utilisateur_id: conge.utilisateur_id,
          conge_type_id: nextCongeTypeId,
          annee: nextYear,
          type: 'ajustement_admin',
          quantite: -safeNumber(newDays),
          solde_apres: safeNumber(nextCounter.jours_acquis) - safeNumber(nextCounter.jours_reserves),
          source_id: conge.id,
          description: descriptionConge('Congé modifié (admin) · nouveau type', nextDateDebut, nextDateFin),
          transaction: t,
        });
      }
    }

    await conge.update({
      ...updates,
      jours_calcules: newDays
    }, { transaction: t });

    if (isPending && user?.id === employe.id) {
      const managers = await Utilisateur.findAll({
        where: { entreprise_id: conge.entreprise_id, role: 'manager', statut: 'actif' },
        transaction: t,
      });
      const admin = await Utilisateur.findOne({
        where: { entreprise_id: conge.entreprise_id, role: 'admin_entreprise' },
        transaction: t,
      });

      const demandeurNom = `${employe.prenom || ''} ${employe.nom || ''}`.trim() || employe.nom || 'Employe';
      const previousPeriod = `${formatDateFR(previousDateDebut)} au ${formatDateFR(previousDateFin)}`;
      const nextPeriod = `${formatDateFR(nextDateDebut)} au ${formatDateFR(nextDateFin)}`;
      const nextCommentaireEmploye = (updates.commentaire_employe ?? conge.commentaire_employe ?? '').toString().trim();

      const recipients = [...managers, admin].filter((recipient) => recipient?.email);

      for (const recipient of recipients) {
        fireEmail({
          to: recipient.email,
          subject: `Demande de conge modifiee - ${demandeurNom}`,
          templateName: 'leave-updated-before-approval',
          data: {
            destinataire_prenom: recipient.prenom || 'Validateur',
            action_requise: 'Action requise',
            contexte_modif: 'sa demande de conge avant validation',
            demandeur_nom: demandeurNom,
            ancienne_periode: previousPeriod,
            nouvelle_periode: nextPeriod,
            type_conge: nextCongeType.libelle || 'Type non renseigne',
            ancien_commentaire_employe: previousCommentaireEmploye || 'Aucun',
            commentaire_employe: nextCommentaireEmploye || 'Aucun',
            action_url: buildCongeUrl(conge.id),
          }
        });
      }
      if (employe.email) {
        emailService.sendLeaveUpdatedSelfConfirm(
          employe,
          nextCongeType.libelle || 'Congé',
          previousPeriod,
          nextPeriod,
          previousCommentaireEmploye || null,
          nextCommentaireEmploye || null
        ).catch((e) => logger.error('sendLeaveUpdatedSelfConfirm error', { error: e.message }));
      }
    }

    if (isFinalValidated && (user?.role === 'admin_entreprise' || user?.role === 'super_admin')) {
      const adminNom = `${user?.prenom || ''} ${user?.nom || ''}`.trim() || 'Administrateur';
      const demandeurNom = `${employe.prenom || ''} ${employe.nom || ''}`.trim() || 'Employé';
      const anciennePeriode = `${formatDateFR(previousDateDebut)} au ${formatDateFR(previousDateFin)}`;
      const nouvellePeriode = `${formatDateFR(nextDateDebut)} au ${formatDateFR(nextDateFin)}`;

      if (employe.email) {
        fireEmail({
          to: employe.email,
          subject: 'Mise a jour de votre conge valide',
          templateName: 'leave-updated-employee',
          data: {
            destinataire_prenom: employe.prenom || 'Collaborateur',
            auteur_action: adminNom,
            type_conge: nextCongeType.libelle || 'Congé',
            ancienne_periode: anciennePeriode,
            nouvelle_periode: nouvellePeriode,
            action_url: buildCongeUrl(conge.id),
          }
        });
      }
      await notificationService.creerNotification({
        entreprise_id: conge.entreprise_id,
        utilisateur_id: employe.id,
        type: 'conge_modifie_admin',
        message: `Votre congé du ${formatDateFR(previousDateDebut)} au ${formatDateFR(previousDateFin)} a été modifié par ${adminNom} (nouvelle période : ${formatDateFR(nextDateDebut)} au ${formatDateFR(nextDateFin)})`,
        url: `/conges/${conge.id}`,
        transaction: t
      });

      // Notifier les managers selon le workflow
      const baseLeaveRulesUpdate = await getEntrepriseLeaveRules(conge.entreprise_id, t);
      const leaveRulesUpdate = getEffectiveLeaveRules(baseLeaveRulesUpdate, employe?.service || null);
      const workflowNeedsManager = ['manager_only', 'manager', 'manager_admin'].includes(leaveRulesUpdate.approval_workflow);

      if (workflowNeedsManager) {
        const managers = await Utilisateur.findAll({
          where: { entreprise_id: conge.entreprise_id, role: 'manager', statut: 'actif' },
          transaction: t,
        });
        for (const manager of managers) {
          if (manager.email) {
            fireEmail({
              to: manager.email,
              subject: `Conge valide modifie par l'admin - ${demandeurNom}`,
              templateName: 'leave-updated-before-approval',
              data: {
                destinataire_prenom: manager.prenom || 'Manager',
                action_requise: 'Pour information',
                contexte_modif: `son conge valide (modifie par ${adminNom})`,
                demandeur_nom: demandeurNom,
                ancienne_periode: anciennePeriode,
                nouvelle_periode: nouvellePeriode,
                type_conge: nextCongeType.libelle || 'Congé',
                ancien_commentaire_employe: previousCommentaireEmploye || 'Aucun',
                commentaire_employe: (updates.commentaire_employe ?? conge.commentaire_employe ?? '').toString().trim() || 'Aucun',
                action_url: buildCongeUrl(conge.id),
              }
            });
          }
          await notificationService.creerNotification({
            entreprise_id: conge.entreprise_id,
            utilisateur_id: manager.id,
            type: 'conge_modifie_admin',
            message: `Le congé de ${demandeurNom} du ${formatDateFR(previousDateDebut)} au ${formatDateFR(previousDateFin)} a été modifié par ${adminNom} (nouvelle période : ${formatDateFR(nextDateDebut)} au ${formatDateFR(nextDateFin)})`,
            url: `/conges/${conge.id}`,
            transaction: t
          });
        }
      }
    }

    if (isFinalValidated && user?.id === employe.id) {
      const demandeurNom = `${employe.prenom || ''} ${employe.nom || ''}`.trim() || employe.nom || 'Employe';
      const previousPeriod = `${formatDateFR(previousDateDebut)} au ${formatDateFR(previousDateFin)}`;
      const nextPeriod = `${formatDateFR(nextDateDebut)} au ${formatDateFR(nextDateFin)}`;
      const nextCommentaireEmploye = (updates.commentaire_employe ?? conge.commentaire_employe ?? '').toString().trim();

      const managers = await Utilisateur.findAll({
        where: { entreprise_id: conge.entreprise_id, role: 'manager', statut: 'actif' },
        transaction: t,
      });
      const admin = await Utilisateur.findOne({
        where: { entreprise_id: conge.entreprise_id, role: 'admin_entreprise' },
        transaction: t,
      });
      const recipients = [...managers, admin].filter((recipient) => recipient?.email);

      for (const recipient of recipients) {
        fireEmail({
          to: recipient.email,
          subject: `Conge valide modifie - ${demandeurNom}`,
          templateName: 'leave-updated-before-approval',
          data: {
            destinataire_prenom: recipient.prenom || 'Responsable',
            action_requise: 'Pour information',
            contexte_modif: 'son conge valide',
            demandeur_nom: demandeurNom,
            ancienne_periode: previousPeriod,
            nouvelle_periode: nextPeriod,
            type_conge: nextCongeType.libelle || 'Type non renseigne',
            ancien_commentaire_employe: previousCommentaireEmploye || 'Aucun',
            commentaire_employe: nextCommentaireEmploye || 'Aucun',
            action_url: buildCongeUrl(conge.id),
          }
        });
      }
      await notificationService.creerNotification({
        entreprise_id: conge.entreprise_id,
        utilisateur_id: employe.id,
        type: 'conge_modifie_employe',
        message: `Votre congé du ${formatDateFR(previousDateDebut)} au ${formatDateFR(previousDateFin)} a été modifié (nouvelle période : ${formatDateFR(nextDateDebut)} au ${formatDateFR(nextDateFin)})`,
        url: `/conges/${conge.id}`,
        transaction: t
      });
    }

    return conge;
  });
}

async function deleteConge(id, user, options = {}) {
  const cancellationComment = (options?.commentaire || '').trim();

  await sequelize.transaction(async (t) => {
    const conge = await Conge.findByPk(id, { transaction: t, lock: t.LOCK.UPDATE });
    if (!conge) throw new Error('Congé introuvable');

    const employe = await Utilisateur.findByPk(conge.utilisateur_id, {
      attributes: ['id', 'prenom', 'nom', 'email'],
      transaction: t,
    });
    if (!employe) throw new Error('Employé introuvable');

    const isAdminLevel = user?.role === 'admin_entreprise' || user?.role === 'super_admin';

    if (!isAdminLevel && user?.id !== conge.utilisateur_id) {
      throw new Error('Suppression non autorisée');
    }

    if (user?.role === 'admin_entreprise' && user?.entreprise_id !== conge.entreprise_id) {
      throw new Error('Accès interdit: entreprise différente');
    }

    const isReserved = conge.statut === 'reserve';
    const isPending = conge.statut === 'en_attente_manager';
    const isManagerValidated = conge.statut === 'valide_manager';
    const isFinalValidated = conge.statut === 'valide_final';

    if (!isReserved && !isPending && !isManagerValidated && !isFinalValidated) throw new Error('Impossible de supprimer');

    // Vérifier la politique d'auto-annulation pour les demandes en attente
    if (isPending && !isAdminLevel && user?.id === conge.utilisateur_id) {
      const entreprise = await Entreprise.findByPk(conge.entreprise_id, {
        attributes: ['politique_conges'],
        transaction: t,
      });
      const pol = entreprise?.politique_conges || {};

      const allowEmployeeCancel = pol.allow_employee_cancel_own_pending !== undefined
        ? Boolean(pol.allow_employee_cancel_own_pending) : true;
      const allowManagerCancel = pol.allow_manager_cancel_own_pending !== undefined
        ? Boolean(pol.allow_manager_cancel_own_pending) : true;

      if (user?.role === 'employe' && !allowEmployeeCancel) {
        const err = new Error(
          "La politique de l'entreprise n'autorise pas les salariés à annuler leur propre demande en attente"
        );
        err.statusCode = 403;
        throw err;
      }
      if (user?.role === 'manager' && !allowManagerCancel) {
        const err = new Error(
          "La politique de l'entreprise n'autorise pas les managers à annuler leur propre demande en attente"
        );
        err.statusCode = 403;
        throw err;
      }
    }

    // Vérifier la politique pour les congés validés (manager ou final)
    if ((isManagerValidated || isFinalValidated) && !isAdminLevel) {
      const policyValidation = await LeavePolicyService.validateCancellation({
        entrepriseId: conge.entreprise_id,
        congeStatus: conge.statut,
        congeStartDate: conge.date_debut,
        initiatorRole: user?.role,
      });

      if (!policyValidation?.allowed) {
        const err = new Error(policyValidation.reason || 'Annulation non autorisée selon la politique de congés');
        err.statusCode = 403;
        throw err;
      }
    }

    if ((isManagerValidated || isFinalValidated) && !cancellationComment) {
      throw new Error('Le commentaire est obligatoire pour annuler un congé déjà validé');
    }

    const joursConge = await resolveCongeDays(conge);

    const compteur = await CompteurConges.findOne({
      where: { utilisateur_id: conge.utilisateur_id, conge_type_id: conge.conge_type_id, annee: dayjs(conge.date_debut).year() },
      transaction: t,
      lock: t.LOCK.UPDATE,
    });

    if (!compteur) {
      logger.warn('Annulation sans compteur — aucun rollback de solde appliqué', {
        conge_id: id,
        utilisateur_id: conge.utilisateur_id,
        conge_type_id: conge.conge_type_id,
        annee: dayjs(conge.date_debut).year(),
      });
    } else {
      if (isReserved || isPending || isManagerValidated) {
        compteur.jours_reserves = Math.max(0, safeNumber(compteur.jours_reserves) - safeNumber(joursConge));
        compteur.jours_annules = safeNumber(compteur.jours_annules) + safeNumber(joursConge);
      } else {
        compteur.jours_acquis = safeNumber(compteur.jours_acquis) + safeNumber(joursConge);
        compteur.jours_pris = Math.max(0, safeNumber(compteur.jours_pris) - safeNumber(joursConge));
        compteur.jours_annules = safeNumber(compteur.jours_annules) + safeNumber(joursConge);
      }
      await compteur.save({ transaction: t });

      await logMouvement({
        entreprise_id: conge.entreprise_id,
        utilisateur_id: conge.utilisateur_id,
        conge_type_id: conge.conge_type_id,
        annee: dayjs(conge.date_debut).year(),
        type: 'annulation',
        quantite: +joursConge,
        solde_apres: safeNumber(compteur.jours_acquis) - safeNumber(compteur.jours_reserves),
        source_id: conge.id,
        description: descriptionConge('Congé annulé', conge.date_debut, conge.date_fin),
        transaction: t,
      });
    }

    if (isPending && !isAdminLevel) {
      const employe_nom = `${employe.prenom || ''} ${employe.nom || ''}`.trim() || 'Un employé';
      const managers = await Utilisateur.findAll({
        where: { entreprise_id: conge.entreprise_id, role: 'manager', statut: 'actif' },
        attributes: ['id', 'prenom', 'nom', 'email'],
      });
      const admin = await Utilisateur.findOne({
        where: { entreprise_id: conge.entreprise_id, role: 'admin_entreprise', statut: 'actif' },
        attributes: ['id', 'prenom', 'nom', 'email'],
      });
      const recipients = [...managers, ...(admin ? [admin] : [])];
      for (const recipient of recipients) {
        if (recipient.email) {
          fireEmail({
            to: recipient.email,
            subject: `Annulation de demande de congé - ${employe_nom}`,
            templateName: 'leave-cancelled-by-employee',
            data: {
              destinataire_prenom: recipient.prenom || 'Responsable',
              demandeur_nom: employe_nom,
              statut_conge_label: 'demande de congé en attente',
              commentaire: 'Aucun',
              date_debut: formatDateFR(conge.date_debut),
              date_fin: formatDateFR(conge.date_fin),
              action_url: buildCongeUrl(conge.id),
            }
          });
        }
        await notificationService.creerNotification({
          entreprise_id: conge.entreprise_id,
          utilisateur_id: recipient.id,
          type: 'conge_annule_employe',
          message: `${employe_nom} a annulé sa demande de congé du ${formatDateFR(conge.date_debut)} au ${formatDateFR(conge.date_fin)}`,
          url: `/conges`,
          transaction: t,
        });
      }
      if (employe.email) {
        emailService.sendLeaveCancelledSelfConfirm(
          employe,
          formatDateFR(conge.date_debut),
          formatDateFR(conge.date_fin),
          'demande de congé en attente',
          null
        ).catch((e) => logger.error('sendLeaveCancelledSelfConfirm error', { error: e.message }));
      }
    }

    if ((isManagerValidated || isFinalValidated) && !isAdminLevel) {
      const employe_nom = `${employe.prenom || ''} ${employe.nom || ''}`.trim() || 'Un employé';
      const statutLabel = isFinalValidated ? 'congé validé définitivement' : 'congé validé par le manager';
      const managers = await Utilisateur.findAll({
        where: { entreprise_id: conge.entreprise_id, role: 'manager', statut: 'actif' },
        attributes: ['id', 'prenom', 'nom', 'email'],
      });
      const admin = await Utilisateur.findOne({
        where: { entreprise_id: conge.entreprise_id, role: 'admin_entreprise', statut: 'actif' },
        attributes: ['id', 'prenom', 'nom', 'email'],
      });
      const recipients = [...managers, ...(admin ? [admin] : [])];
      for (const recipient of recipients) {
        if (recipient.email) {
          fireEmail({
            to: recipient.email,
            subject: `Annulation de congé validé - ${employe_nom}`,
            templateName: 'leave-cancelled-by-employee',
            data: {
              destinataire_prenom: recipient.prenom || 'Responsable',
              demandeur_nom: employe_nom,
              statut_conge_label: statutLabel,
              commentaire: cancellationComment || 'Aucun',
              date_debut: formatDateFR(conge.date_debut),
              date_fin: formatDateFR(conge.date_fin),
              action_url: buildCongeUrl(conge.id),
            }
          });
        }
        await notificationService.creerNotification({
          entreprise_id: conge.entreprise_id,
          utilisateur_id: recipient.id,
          type: 'conge_annule_employe',
          message: `${employe_nom} a annulé son ${statutLabel} du ${formatDateFR(conge.date_debut)} au ${formatDateFR(conge.date_fin)}. Motif : ${cancellationComment || 'non précisé'}`,
          url: `/conges`,
          transaction: t,
        });
      }
      if (employe.email) {
        emailService.sendLeaveCancelledSelfConfirm(
          employe,
          formatDateFR(conge.date_debut),
          formatDateFR(conge.date_fin),
          statutLabel,
          cancellationComment || null
        ).catch((e) => logger.error('sendLeaveCancelledSelfConfirm error', { error: e.message }));
      }
    }

    if ((isManagerValidated || isFinalValidated) && isAdminLevel) {
      const adminNom = `${user?.prenom || ''} ${user?.nom || ''}`.trim() || 'Administrateur';
      const employe_nom = `${employe.prenom || ''} ${employe.nom || ''}`.trim() || 'Un employé';
      if (employe.email) {
        fireEmail({
          to: employe.email,
          subject: 'Annulation de votre conge valide',
          templateName: 'leave-cancelled-employee',
          data: {
            destinataire_prenom: employe.prenom || 'Collaborateur',
            auteur_action: adminNom,
            type_conge: conge.conge_type?.libelle || 'Congé',
            date_debut: formatDateFR(conge.date_debut),
            date_fin: formatDateFR(conge.date_fin),
            commentaire: cancellationComment,
            action_url: buildCongeUrl(conge.id),
          }
        });
      }
      await notificationService.creerNotification({
        entreprise_id: conge.entreprise_id,
        utilisateur_id: employe.id,
        type: 'conge_annule_admin',
        message: `Votre congé du ${formatDateFR(conge.date_debut)} au ${formatDateFR(conge.date_fin)} a été annulé par ${adminNom}. Motif: ${cancellationComment}`,
        url: `/conges/${conge.id}`,
        transaction: t
      });
      const managers = await Utilisateur.findAll({
        where: { entreprise_id: conge.entreprise_id, role: 'manager', statut: 'actif' },
        attributes: ['id', 'prenom', 'nom', 'email'],
      });
      for (const manager of managers) {
        if (manager.email) {
          emailService.sendLeaveCancelledByAdmin(
            manager,
            employe_nom,
            adminNom,
            formatDateFR(conge.date_debut),
            formatDateFR(conge.date_fin),
            cancellationComment || null
          ).catch((e) => logger.error('sendLeaveCancelledByAdmin error', { error: e.message }));
        }
      }
    }

    await conge.destroy({ transaction: t });
  });
}

async function calculateDaysPreview({ date_debut, date_fin, debut_demi_journee, fin_demi_journee }, reqUser) {
  if (!validateDateRange(date_debut, date_fin)) throw new Error('Dates invalides ou date_fin < date_debut');

  const entrepriseId = reqUser.entreprise_id;
  const jours = await calcJoursConges(
    entrepriseId,
    date_debut,
    date_fin,
    debut_demi_journee || 'matin',
    fin_demi_journee || 'apres_midi'
  );

  const leaveRules = await getEntrepriseLeaveRules(entrepriseId);
  const blockedDays = leaveRules.blocked_days || {};

  return {
    jours,
    politique: {
      exclude_weekends: blockedDays.exclude_weekends !== false,
      exclude_holidays: blockedDays.exclude_holidays !== false,
      count_saturday: blockedDays.count_saturday === true,
      count_sunday: blockedDays.count_sunday === true,
      autoriser_reservation_sans_solde: leaveRules.autoriser_reservation_sans_solde !== false,
    },
  };
}

async function activerReservation(congeId, reqUser) {
  const emailQueue = [];
  const conge = await sequelize.transaction(async (t) => {
    const conge = await Conge.findByPk(congeId, { transaction: t, lock: t.LOCK.UPDATE });
    if (!conge) throw new Error('Congé introuvable');
    if (conge.statut !== 'reserve') throw new Error('Ce congé n\'est pas une réservation');
    if (reqUser.entreprise_id !== conge.entreprise_id) throw new Error('Accès interdit');

    // Respecter le workflow configuré et vérifier le solde (fix #41 + #42).
    const baseLeaveRules = await getEntrepriseLeaveRules(conge.entreprise_id, t);
    const employe = await Utilisateur.findByPk(conge.utilisateur_id, { transaction: t });
    const leaveRules = getEffectiveLeaveRules(baseLeaveRules, employe?.service || null);
    const joursConge = safeNumber(conge.jours_calcules);

    // Charger le compteur avec verrou pour vérifier le solde et le mettre à jour.
    const annee = dayjs(conge.date_debut).year();
    const compteur = await CompteurConges.findOne({
      where: {
        utilisateur_id: conge.utilisateur_id,
        conge_type_id: conge.conge_type_id,
        annee,
      },
      transaction: t,
      lock: t.LOCK.UPDATE,
    });

    // Fix #42 : vérifier que le solde couvre cette activation.
    // Les joursConge sont déjà dans jours_reserves depuis la création de la réservation.
    // soldeDispo = jours_acquis - (jours_reserves - joursConge) : solde disponible une
    // fois qu'on retire la réservation courante des réserves pour évaluer si elle est couverte.
    if (compteur) {
      const soldeDispo = safeNumber(compteur.jours_acquis)
        - safeNumber(compteur.jours_reserves)
        + joursConge;
      if (soldeDispo < joursConge) {
        const disponible = Math.max(0, soldeDispo);
        throw Object.assign(
          new Error(`Solde insuffisant pour activer cette réservation : ${disponible} jour(s) disponible(s), ${joursConge} jour(s) requis`),
          { statusCode: 400 }
        );
      }
    }

    if (leaveRules.approval_workflow === 'auto') {
      conge.statut = 'valide_final';
      // Sortir les jours du bucket 'reserves' et les consommer définitivement
      if (compteur) {
        compteur.jours_reserves = Math.max(0, safeNumber(compteur.jours_reserves) - joursConge);
        compteur.jours_acquis   = Math.max(0, safeNumber(compteur.jours_acquis)   - joursConge);
        compteur.jours_pris     = safeNumber(compteur.jours_pris) + joursConge;
        await compteur.save({ transaction: t });
      }
    } else {
      conge.statut = 'en_attente_manager';
      // Les jours restent dans jours_reserves — aucun mouvement de compteur nécessaire.
    }

    await conge.save({ transaction: t });

    const congeType = await CongeType.findByPk(conge.conge_type_id, { transaction: t });
    const employeNom = `${employe?.prenom || ''} ${employe?.nom || ''}`.trim() || 'L\'employé';

    emailQueue.push({
      to: employe?.email,
      subject: 'Votre réservation est maintenant une demande active',
      templateName: 'leave-reservation-activated',
      data: {
        destinataire_prenom: employe?.prenom || 'Employé',
        type_conge: congeType?.libelle || 'Congé',
        date_debut: formatDateFR(conge.date_debut),
        date_fin: formatDateFR(conge.date_fin),
        action_url: buildCongeUrl(conge.id),
      }
    });

    await notificationService.creerNotification({
      entreprise_id: conge.entreprise_id,
      utilisateur_id: conge.utilisateur_id,
      type: 'conge_demande',
      message: `Votre réservation de congé (${formatDateFR(conge.date_debut)} - ${formatDateFR(conge.date_fin)}) a été activée et est en attente de validation.`,
      url: `/conges/${conge.id}`,
      transaction: t,
    });

    return conge;
  });

  emailQueue.forEach(payload => fireEmail(payload));
  return conge;
}

/**
 * Tente d'activer toutes les réservations prévisionnelles (statut='reserve')
 * d'un compteur donné dont le solde est maintenant suffisant.
 *
 * Exécutée après chaque mutation de compteur (admin, cron mensuel, init annuel).
 * Toujours dans sa propre transaction avec verrou FOR UPDATE sur le compteur
 * pour sérialiser les accès concurrents.
 *
 * @param {string}  utilisateurId
 * @param {string}  congeTypeId
 * @param {number}  annee         — année du compteur crédité
 * @returns {{ activated: Array, still_pending: Array, error?: string }}
 */
async function tryActivateReservations(utilisateurId, congeTypeId, annee) {
  const emailQueue = [];
  const results = { activated: [], still_pending: [] };

  try {
    await sequelize.transaction(async (t) => {
      // Verrou exclusif sur le compteur pour sérialiser les mutations concurrentes
      const compteur = await CompteurConges.findOne({
        where: { utilisateur_id: utilisateurId, conge_type_id: congeTypeId, annee: Number(annee) },
        transaction: t,
        lock: t.LOCK.UPDATE,
      });
      if (!compteur) return;

      // Toutes les réservations de l'année triées par date_debut (FIFO)
      const reservations = await Conge.findAll({
        where: { utilisateur_id: utilisateurId, conge_type_id: congeTypeId, statut: 'reserve' },
        order: [['date_debut', 'ASC']],
        transaction: t,
        lock: t.LOCK.UPDATE,
      });

      const yearReservations = reservations.filter(
        (r) => dayjs(r.date_debut).year() === Number(annee)
      );
      if (yearReservations.length === 0) return;

      // Règles entreprise chargées une seule fois
      const baseLeaveRules = await getEntrepriseLeaveRules(yearReservations[0].entreprise_id, t);

      // Budget FIFO : on part de jours_acquis (brut) et on consomme au fil des activations.
      // jours_reserves peut dépasser jours_acquis quand des réservations ont été faites
      // avant que le solde soit suffisant. En évaluant chaque réservation séquentiellement
      // contre le budget restant (pas contre le total reserves), on obtient le bon
      // comportement partiel : la 1ère réservation peut s'activer même si le solde
      // ne couvre pas toutes les réservations en attente.
      let budget = Math.max(0, safeNumber(compteur.jours_acquis) - safeNumber(compteur.jours_reserves));

      for (const conge of yearReservations) {
        const jours = safeNumber(conge.jours_calcules);

        if (budget < jours) {
          const solde_manquant = Number((jours - budget).toFixed(2));
          results.still_pending.push({
            conge_id: conge.id,
            date_debut: formatDateFR(conge.date_debut),
            date_fin: formatDateFR(conge.date_fin),
            jours,
            solde_manquant,
          });
          logger.info(`[try-activate] ${conge.id} — budget insuffisant (budget=${budget.toFixed(2)}, requis=${jours})`);
          await auditConge.skipped(conge, { jours, budget: Number(budget.toFixed(2)), solde_manquant, annee: Number(annee) });
          continue;
        }

        budget -= jours; // Consommer le budget avant l'activation

        const employe = await Utilisateur.findByPk(conge.utilisateur_id, { transaction: t });
        const leaveRules = getEffectiveLeaveRules(baseLeaveRules, employe?.service || null);
        const employeNom = `${employe?.prenom || ''} ${employe?.nom || ''}`.trim();

        let newStatut;
        if (leaveRules.approval_workflow === 'auto') {
          newStatut = 'valide_final';
          // Consommer définitivement les jours
          compteur.jours_reserves = Math.max(0, safeNumber(compteur.jours_reserves) - jours);
          compteur.jours_acquis   = Math.max(0, safeNumber(compteur.jours_acquis)   - jours);
          compteur.jours_pris     = safeNumber(compteur.jours_pris) + jours;
          await compteur.save({ transaction: t });
          await logMouvement({
            entreprise_id: conge.entreprise_id,
            utilisateur_id: conge.utilisateur_id,
            conge_type_id: compteur.conge_type_id,
            annee: Number(annee),
            type: 'activation_reservation',
            quantite: -jours,
            solde_apres: safeNumber(compteur.jours_acquis) - safeNumber(compteur.jours_reserves),
            source_id: conge.id,
            description: descriptionConge('Réservation N+1 activée', conge.date_debut, conge.date_fin),
            transaction: t,
          });
        } else {
          newStatut = 'en_attente_manager';
          // Les jours restent dans reserves — aucun mouvement de compteur
        }

        conge.statut = newStatut;
        await conge.save({ transaction: t });

        results.activated.push({
          conge_id: conge.id,
          date_debut: formatDateFR(conge.date_debut),
          date_fin: formatDateFR(conge.date_fin),
          jours,
          new_statut: newStatut,
        });

        logger.info(`[try-activate] ${conge.id} activé → ${newStatut} (${jours} j, employe=${utilisateurId})`);
        // Écriture après commit : garantit que le log n'existe que si la transaction a réussi.
        t.afterCommit(() => auditConge.activated(conge, { from_statut: 'reserve', new_statut: newStatut, jours, annee: Number(annee) }));

        // Notification SSE à l'employé (via afterCommit géré par creerNotification)
        const statutLabel = newStatut === 'valide_final' ? 'validée automatiquement' : 'en attente de validation';
        await notificationService.creerNotification({
          entreprise_id: conge.entreprise_id,
          utilisateur_id: conge.utilisateur_id,
          type: 'conge_reserve_active',
          message: `Votre réservation du ${formatDateFR(conge.date_debut)} au ${formatDateFR(conge.date_fin)} a été activée automatiquement — ${statutLabel}.`,
          url: `/conges/${conge.id}`,
          transaction: t,
        });

        // Notification managers/admin si validation requise
        if (newStatut === 'en_attente_manager') {
          const managers = await Utilisateur.findAll({
            where: { entreprise_id: conge.entreprise_id, role: 'manager', statut: 'actif' },
            transaction: t,
          });
          const admin = await Utilisateur.findOne({
            where: { entreprise_id: conge.entreprise_id, role: 'admin_entreprise' },
            transaction: t,
          });
          for (const recipient of [...managers, ...(admin ? [admin] : [])]) {
            await notificationService.creerNotification({
              entreprise_id: conge.entreprise_id,
              utilisateur_id: recipient.id,
              type: 'conge_reserve_active',
              message: `La réservation de ${employeNom} (${formatDateFR(conge.date_debut)} - ${formatDateFR(conge.date_fin)}) est maintenant en attente de validation.`,
              url: `/conges/${conge.id}`,
              transaction: t,
            });
          }
        }

        const congeType = await CongeType.findByPk(conge.conge_type_id, { transaction: t });
        emailQueue.push({
          to: employe?.email,
          subject: 'Votre réservation de congé a été activée',
          templateName: 'leave-reservation-activated',
          data: {
            destinataire_prenom: employe?.prenom || 'Employé',
            type_conge: congeType?.libelle || 'Congé',
            date_debut: formatDateFR(conge.date_debut),
            date_fin: formatDateFR(conge.date_fin),
            statut_label: statutLabel,
            action_url: buildCongeUrl(conge.id),
          },
        });
      }
    });

    emailQueue.forEach((payload) => fireEmail(payload));
  } catch (err) {
    logger.error(`[try-activate] Erreur pour ${utilisateurId}/${congeTypeId}/${annee}:`, { error: err.message });
    results.error = err.message;
  }

  return results;
}

module.exports = {
  checkOverlapConge,
  getValidationOverlapStatus,
  createConge,
  getConges,
  getCongeById,
  updateConge,
  deleteConge,
  validerConge,
  rejeterConge,
  activerReservation,
  tryActivateReservations,
  calcJoursConges,
  calculateDaysPreview
};