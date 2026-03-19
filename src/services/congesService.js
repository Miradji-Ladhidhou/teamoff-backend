const { Conge, CompteurConges, CongeType, Utilisateur, Entreprise, sequelize } = require('../models');
const notificationService = require('./notificationService');
const { auditConge } = require('./auditHelper');
const { ensureCounter } = require('./quotasService');
const joursFeriesService = require('./joursFeriesService');
const { getLeaveRules, getEffectiveLeaveRules } = require('./politiqueConges');
const { Op } = require('sequelize');
const dayjs = require('dayjs');
const isSameOrBefore = require('dayjs/plugin/isSameOrBefore');
const { validateUUID, validateDateRange, validateDemiJournee } = require('../utils/validation');

dayjs.extend(isSameOrBefore);

const FRONTEND_URL = process.env.FRONTEND_URL || '';

function buildCongeUrl(congeId) {
  const path = `/conges/${congeId}`;
  return FRONTEND_URL ? `${FRONTEND_URL}${path}` : path;
}

function safeNumber(value) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function buildDateKey(dateValue) {
  return dayjs(dateValue).format('YYYY-MM-DD');
}

function shouldCountLeaveDay(current, joursFeriesSet, blockedDays) {
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

  if (excludeHolidays && joursFeriesSet.has(dateKey)) {
    return false;
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

function calculateBusinessDays(conge, joursFeriesSet, blockedDays) {
  let total = 0;
  let current = dayjs(conge.date_debut);
  const end = dayjs(conge.date_fin);

  while (current.isSameOrBefore(end, 'day')) {
    if (shouldCountLeaveDay(current, joursFeriesSet, blockedDays)) {
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

function calculateLeaveBreakdown(conge, joursFeriesSet, blockedDays) {
  let joursDansPeriode = 0;
  let joursBloques = 0;
  let joursFeriesExclus = 0;
  let joursPrisCalcules = 0;
  const datesNonPrises = [];
  let current = dayjs(conge.date_debut);
  const end = dayjs(conge.date_fin);

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
    } else if (excludeHolidays && joursFeriesSet.has(dateKey)) {
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

async function computeOverlapContext({ entrepriseId, utilisateurId, dateDebut, dateFin, userService = null, transaction = null }) {
  const overlappingConges = await Conge.findAll({
    where: {
      entreprise_id: entrepriseId,
      statut: { [Op.in]: ['en_attente_manager', 'valide_manager', 'valide_final'] },
      date_debut: { [Op.lte]: dateFin },
      date_fin: { [Op.gte]: dateDebut }
    },
    include: [{
      model: Utilisateur,
      as: 'utilisateur',
      attributes: ['id', 'service'],
      required: false,
    }],
    attributes: ['id', 'utilisateur_id'],
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

function buildOverlapMessage({ dateDebut, dateFin, overlapWithSameUser, limitReached, serviceLimitReached, userService, projectedOnLeaveCount, globalLimit, projectedServiceOnLeaveCount, serviceLimit }) {
  if (overlapWithSameUser) {
    return 'Chevauchement de congé détecté';
  }

  const details = [];
  if (limitReached) {
    details.push(`Capacité globale dépassée (${projectedOnLeaveCount}/${globalLimit})`);
  }
  if (serviceLimitReached) {
    details.push(`Capacité du service ${userService || 'inconnu'} dépassée (${projectedServiceOnLeaveCount}/${serviceLimit})`);
  }

  if (!details.length) {
    return null;
  }

  return `Alerte chevauchement (${dateDebut} - ${dateFin}) : ${details.join(' ; ')}`;
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

  if (!['employe', 'manager'].includes(reqUser?.role)) {
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

  const baseLeaveRules = await getEntrepriseLeaveRules(utilisateur.entreprise_id);
  const leaveRules = getEffectiveLeaveRules(baseLeaveRules, utilisateur.service || null);

  const overlapContext = await computeOverlapContext({
    entrepriseId: utilisateur.entreprise_id,
    utilisateurId,
    dateDebut: date_debut,
    dateFin: date_fin,
    userService: utilisateur.service || null,
  });

  const globalLimit = Number(leaveRules.max_employees_on_leave.global);
  const projectedOnLeaveCount = overlapContext.overlappingCount + 1;
  const limitReached = Number.isFinite(globalLimit) && projectedOnLeaveCount > globalLimit;

  const userService = utilisateur.service || null;
  const serviceLimit = Number(userService ? leaveRules.max_employees_on_leave.by_service?.[userService] : null);
  const projectedServiceOnLeaveCount = overlapContext.overlappingCountByService + 1;
  const serviceLimitReached = Boolean(
    userService && Number.isFinite(serviceLimit) && serviceLimit > 0 && projectedServiceOnLeaveCount > serviceLimit
  );

  const message = buildOverlapMessage({
    dateDebut: date_debut,
    dateFin: date_fin,
    overlapWithSameUser: overlapContext.overlapWithSameUser,
    limitReached,
    serviceLimitReached,
    userService,
    projectedOnLeaveCount,
    globalLimit,
    projectedServiceOnLeaveCount,
    serviceLimit,
  });

  if (overlapContext.overlapWithSameUser || (leaveRules.overlap_policy === 'block' && (limitReached || serviceLimitReached))) {
    return {
      action: 'block',
      message: message || 'Cette demande est bloquée par la politique de chevauchement.',
      overlapWithSameUser: overlapContext.overlapWithSameUser,
      limitReached,
      serviceLimitReached,
      policy: leaveRules.overlap_policy,
      projectedOnLeaveCount,
      globalLimit: Number.isFinite(globalLimit) ? globalLimit : null,
      projectedServiceOnLeaveCount,
      serviceLimit: Number.isFinite(serviceLimit) ? serviceLimit : null,
      userService,
    };
  }

  if (leaveRules.overlap_policy === 'warning' && (limitReached || serviceLimitReached)) {
    return {
      action: 'warning',
      message: message || 'Attention: un chevauchement a été détecté.',
      overlapWithSameUser: overlapContext.overlapWithSameUser,
      limitReached,
      serviceLimitReached,
      policy: leaveRules.overlap_policy,
      projectedOnLeaveCount,
      globalLimit: Number.isFinite(globalLimit) ? globalLimit : null,
      projectedServiceOnLeaveCount,
      serviceLimit: Number.isFinite(serviceLimit) ? serviceLimit : null,
      userService,
    };
  }

  return {
    action: 'allow',
    message: null,
    overlapWithSameUser: false,
    limitReached: false,
    serviceLimitReached: false,
    policy: leaveRules.overlap_policy,
    projectedOnLeaveCount,
    globalLimit: Number.isFinite(globalLimit) ? globalLimit : null,
    projectedServiceOnLeaveCount,
    serviceLimit: Number.isFinite(serviceLimit) ? serviceLimit : null,
    userService,
  };
}

// ----------------------------
// Calcul des jours ouvrés
// ----------------------------
async function calcJoursConges(entrepriseId, dateDebut, dateFin, debut_demi, fin_demi) {
  let total = 0;
  let current = dayjs(dateDebut);
  const end = dayjs(dateFin);
  const leaveRules = await getEntrepriseLeaveRules(entrepriseId);
  const blockedDays = leaveRules.blocked_days || {};

  // Récupérer les jours fériés de l'entreprise
  const joursFeries = await joursFeriesService.getJoursFeriesEntreprise(entrepriseId);
  const joursFeriesSet = new Set((joursFeries || []).map((jf) => buildDateKey(jf.date)));

  while (current.isSameOrBefore(end, 'day')) {
    if (shouldCountLeaveDay(current, joursFeriesSet, blockedDays)) {
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
  return sequelize.transaction(async (t) => {
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

    if (!['employe', 'manager'].includes(reqUser?.role)) {
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
    if (daysUntilStart < leaveRules.minimum_notice_days) {
      throw new Error(`Délai minimum non respecté: ${leaveRules.minimum_notice_days} jour(s) minimum`);
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

    const globalLimit = leaveRules.max_employees_on_leave.global;
    const projectedOnLeaveCount = overlapContext.overlappingCount + 1;
    const limitReached = Number.isFinite(globalLimit) && projectedOnLeaveCount > globalLimit;

    const userService = utilisateur.service || null;
    const serviceLimitRaw = userService
      ? leaveRules.max_employees_on_leave.by_service?.[userService]
      : null;
    const serviceLimit = Number(serviceLimitRaw);
    const projectedServiceOnLeaveCount = overlapContext.overlappingCountByService + 1;
    const serviceLimitReached = userService && Number.isFinite(serviceLimit) && serviceLimit > 0
      ? projectedServiceOnLeaveCount > serviceLimit
      : false;

    const overlapMessage = buildOverlapMessage({
      dateDebut: date_debut,
      dateFin: date_fin,
      overlapWithSameUser: overlapContext.overlapWithSameUser,
      limitReached,
      serviceLimitReached,
      userService,
      projectedOnLeaveCount,
      globalLimit,
      projectedServiceOnLeaveCount,
      serviceLimit,
    });

    const overlapWarningPayload = leaveRules.overlap_policy === 'warning' && (limitReached || serviceLimitReached)
      ? {
        message: overlapMessage || 'Attention: un chevauchement a été détecté.',
        limitReached,
        serviceLimitReached,
        globalLimit: Number.isFinite(Number(globalLimit)) ? Number(globalLimit) : null,
        projectedOnLeaveCount,
        serviceLimit: Number.isFinite(serviceLimit) ? serviceLimit : null,
        projectedServiceOnLeaveCount,
        userService,
      }
      : null;

    if (overlapContext.overlapWithSameUser) {
      throw new Error(overlapMessage || 'Chevauchement de congé détecté');
    }

    if (leaveRules.overlap_policy === 'block' && (limitReached || serviceLimitReached)) {
      throw new Error(overlapMessage || 'Limite d\'employés en congé simultanément atteinte');
    }

    const jours = await calcJoursConges(utilisateur.entreprise_id, date_debut, date_fin, debutDemiJournee, finDemiJournee);
    if (!Number.isFinite(jours) || jours <= 0) throw new Error('Nombre de jours de congé invalide');

    if (jours > leaveRules.max_consecutive_days) {
      throw new Error(`Durée maximale dépassée: ${leaveRules.max_consecutive_days} jour(s) consécutif(s) max`);
    }

    // Compteur
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

    if (jours > (safeNumber(compteur.jours_acquis) - safeNumber(compteur.jours_reserves))) {
      throw new Error('Solde insuffisant');
    }

    const approvalWorkflow = leaveRules.approval_workflow;
    if (approvalWorkflow === 'auto') {
      compteur.jours_acquis = Math.max(0, safeNumber(compteur.jours_acquis) - safeNumber(jours));
      compteur.jours_pris = safeNumber(compteur.jours_pris) + safeNumber(jours);
    } else {
      compteur.jours_reserves = safeNumber(compteur.jours_reserves) + safeNumber(jours);
    }
    await compteur.save({ transaction: t });

    const conge = await Conge.create({
      utilisateur_id: utilisateurId,
      entreprise_id: utilisateur.entreprise_id,
      conge_type_id,
      date_debut,
      date_fin,
      debut_demi_journee: debutDemiJournee,
      fin_demi_journee: finDemiJournee,
      commentaire_employe,
      statut: approvalWorkflow === 'auto' ? 'valide_final' : 'en_attente_manager',
      jours_calcules: jours
    }, { transaction: t });

    // Notification au manager et admin entreprise
    const manager = await Utilisateur.findOne({
      where: { entreprise_id: utilisateur.entreprise_id, role: 'manager' }
    });
    const admin = await Utilisateur.findOne({
      where: { entreprise_id: utilisateur.entreprise_id, role: 'admin_entreprise' }
    });

    const shouldNotifyOnCreate = leaveRules.notification_settings.on_create;

    const utilisateurNomComplet = `${utilisateur.prenom || ''} ${utilisateur.nom || ''}`.trim() || utilisateur.nom;

    if (shouldNotifyOnCreate && manager) {
      await notificationService.sendEmail({
        to: manager.email,
        subject: `Nouvelle demande de conge - ${utilisateurNomComplet}`,
        templateName: 'leave-new-request-manager',
        data: {
          destinataire_prenom: manager.prenom || 'Manager',
          demandeur_nom: utilisateurNomComplet,
          date_debut,
          date_fin,
          type_conge: congeType.libelle || 'Type non renseigne',
          commentaire_employe: commentaire_employe || 'Aucun',
          overlap_warning_html: overlapWarningPayload
            ? `<div style="margin-top:12px;padding:12px;border:1px solid #f59e0b;background:#fffbeb;border-radius:8px;color:#92400e;"><strong>Alerte chevauchement :</strong><br/>${overlapWarningPayload.message}</div>`
            : '',
          action_url: buildCongeUrl(conge.id),
        }
      });
      await notificationService.creerNotification({
        entreprise_id: utilisateur.entreprise_id,
        utilisateur_id: manager.id,
        type: 'conge_demande',
        message: `Nouvelle demande de congé de ${utilisateurNomComplet} (${date_debut} - ${date_fin})`,
        url: `/conges/${conge.id}`
      });
    }

    if (shouldNotifyOnCreate && admin) {
      await notificationService.sendEmail({
        to: admin.email,
        subject: `Nouvelle demande de conge - ${utilisateurNomComplet}`,
        templateName: 'leave-new-request-manager',
        data: {
          destinataire_prenom: admin.prenom || 'Administrateur',
          demandeur_nom: utilisateurNomComplet,
          date_debut,
          date_fin,
          type_conge: congeType.libelle || 'Type non renseigne',
          commentaire_employe: commentaire_employe || 'Aucun',
          overlap_warning_html: overlapWarningPayload
            ? `<div style="margin-top:12px;padding:12px;border:1px solid #f59e0b;background:#fffbeb;border-radius:8px;color:#92400e;"><strong>Alerte chevauchement :</strong><br/>${overlapWarningPayload.message}</div>`
            : '',
          action_url: buildCongeUrl(conge.id),
        }
      });
      await notificationService.creerNotification({
        entreprise_id: utilisateur.entreprise_id,
        utilisateur_id: admin.id,
        type: 'conge_demande',
        message: `Nouvelle demande de congé de ${utilisateurNomComplet} (${date_debut} - ${date_fin})`,
        url: `/conges/${conge.id}`
      });
    }

    // Notification à l'employé : congé créé
    if (shouldNotifyOnCreate) {
      await notificationService.sendEmail({
        to: utilisateur.email,
        subject: 'Confirmation de creation de votre demande de conge',
        templateName: 'leave-created-employee',
        data: {
          destinataire_prenom: utilisateur.prenom || 'Collaborateur',
          date_debut,
          date_fin,
          statut_label: approvalWorkflow === 'auto' ? 'Validee automatiquement' : 'En attente de validation',
          overlap_warning_html: overlapWarningPayload
            ? `<div style="margin-top:12px;padding:12px;border:1px solid #f59e0b;background:#fffbeb;border-radius:8px;color:#92400e;"><strong>Alerte chevauchement :</strong><br/>${overlapWarningPayload.message}</div>`
            : '',
          action_url: buildCongeUrl(conge.id),
        }
      });
      await notificationService.creerNotification({
        entreprise_id: utilisateur.entreprise_id,
        utilisateur_id: utilisateur.id,
        type: 'conge_cree',
        message: `Votre congé du ${date_debut} au ${date_fin} ${approvalWorkflow === 'auto' ? 'a été validé automatiquement' : 'est en attente de validation'}`,
        url: `/conges/${conge.id}`
      });
    }

    if (overlapWarningPayload) {
      await notificationService.creerNotification({
        entreprise_id: utilisateur.entreprise_id,
        utilisateur_id: reqUser.id,
        type: 'conge_conflit_warning',
        message: overlapWarningPayload.message,
        url: `/conges/${conge.id}`
      });
    }

    // Audit
    await auditConge.created(conge, reqUser, req || null);

    const congeResponse = conge.toJSON();
    if (overlapWarningPayload) {
      congeResponse.overlap_warning = overlapWarningPayload;
    }

    return congeResponse;
  });
}

// ----------------------------
// Valider un congé
// ----------------------------
async function validerConge(congeId, reqUser, commentaire = null, req = null) {
  return sequelize.transaction(async (t) => {
    const conge = await Conge.findByPk(congeId, { transaction: t });
    if (!conge) throw new Error('Congé introuvable');
    const joursConge = await resolveCongeDays(conge);
    const baseLeaveRules = await getEntrepriseLeaveRules(conge.entreprise_id, t);

    const utilisateur = await Utilisateur.findByPk(conge.utilisateur_id, { transaction: t });
    const leaveRules = getEffectiveLeaveRules(baseLeaveRules, utilisateur?.service || null);

    if (reqUser.role === 'manager') {
      if (leaveRules.approval_workflow === 'auto') {
        throw new Error('Workflow auto: aucune validation manuelle nécessaire');
      }

      if (leaveRules.approval_workflow === 'admin_only') {
        throw new Error('Workflow admin_only: validation par administrateur uniquement');
      }

      if (conge.statut !== 'en_attente_manager') {
        throw new Error('Impossible de valider ce congé à ce stade');
      }

      conge.statut = ['manager', 'manager_only'].includes(leaveRules.approval_workflow)
        ? 'valide_final'
        : 'valide_manager';
      conge.commentaire_manager = commentaire;
      await conge.save({ transaction: t });

      // Notification admin entreprise
      const admin = await Utilisateur.findOne({
        where: { entreprise_id: conge.entreprise_id, role: 'admin_entreprise' }
      });
      if (admin) {
        await notificationService.sendEmail({
          to: admin.email,
          subject: 'Demande de conge validee par le manager - action requise',
          templateName: 'leave-manager-approved-admin',
          data: {
            destinataire_prenom: admin.prenom || 'Administrateur',
            demandeur_nom: `${utilisateur.prenom || ''} ${utilisateur.nom || ''}`.trim() || utilisateur.nom,
            date_debut: conge.date_debut,
            date_fin: conge.date_fin,
            commentaire_employe: conge.commentaire_employe || 'Aucun',
            commentaire_manager: conge.commentaire_manager || 'Aucun',
            action_url: buildCongeUrl(conge.id),
          }
        });
        await notificationService.creerNotification({
          entreprise_id: conge.entreprise_id,
          utilisateur_id: admin.id,
          type: 'conge_valide_manager',
          message: `Congé de ${utilisateur.nom} validé par manager (${conge.date_debut} - ${conge.date_fin})`,
          url: `/conges/${conge.id}`
        });
      }

      if (['manager', 'manager_only'].includes(leaveRules.approval_workflow)) {
        const compteur = await CompteurConges.findOne({
          where: {
            utilisateur_id: conge.utilisateur_id,
            conge_type_id: conge.conge_type_id,
            annee: dayjs(conge.date_debut).year()
          },
          transaction: t,
          lock: t.LOCK.UPDATE
        });
        if (!compteur) throw new Error('Compteur de congés introuvable pour validation');

        compteur.jours_acquis = Math.max(0, safeNumber(compteur.jours_acquis) - safeNumber(joursConge));
        compteur.jours_pris = safeNumber(compteur.jours_pris) + safeNumber(joursConge);
        compteur.jours_reserves = Math.max(0, safeNumber(compteur.jours_reserves) - safeNumber(joursConge));
        await compteur.save({ transaction: t });

        if (leaveRules.notification_settings.on_validate) {
          await notificationService.sendEmail({
            to: utilisateur.email,
            subject: 'Votre demande de conge est approuvee',
            templateName: 'leave-approved-employee',
            data: {
              destinataire_prenom: utilisateur.prenom || 'Collaborateur',
              date_debut: conge.date_debut,
              date_fin: conge.date_fin,
              action_url: buildCongeUrl(conge.id),
            }
          });
          await notificationService.creerNotification({
            entreprise_id: conge.entreprise_id,
            utilisateur_id: utilisateur.id,
            type: 'conge_valide_final',
            message: `Votre congé du ${conge.date_debut} au ${conge.date_fin} a été approuvé`,
            url: `/conges/${conge.id}`
          });
        }
      }

      // Audit
      await auditConge.approved(conge, reqUser, req);
    } else if (reqUser.role === 'admin_entreprise' || reqUser.role === 'super_admin') {
      if (leaveRules.approval_workflow === 'auto') {
        throw new Error('Workflow auto: aucune validation manuelle nécessaire');
      }

      if (['manager', 'manager_only'].includes(leaveRules.approval_workflow)) {
        throw new Error('Workflow manager: validation finale par manager uniquement');
      }

      if (leaveRules.approval_workflow === 'manager_admin' && conge.statut !== 'valide_manager') {
        throw new Error('Workflow manager_admin: validation manager requise avant validation admin');
      }

      if (!['en_attente_manager', 'valide_manager'].includes(conge.statut)) {
        throw new Error('Impossible de valider ce congé à ce stade');
      }

      conge.statut = 'valide_final';
      conge.commentaire_admin = commentaire;
      await conge.save({ transaction: t });

      // Mise à jour compteur
      const compteur = await CompteurConges.findOne({
        where: {
          utilisateur_id: conge.utilisateur_id,
          conge_type_id: conge.conge_type_id,
          annee: dayjs(conge.date_debut).year()
        },
        transaction: t,
        lock: t.LOCK.UPDATE
      });
      if (!compteur) throw new Error('Compteur de congés introuvable pour validation');

      compteur.jours_acquis = Math.max(0, safeNumber(compteur.jours_acquis) - safeNumber(joursConge));
      compteur.jours_pris = safeNumber(compteur.jours_pris) + safeNumber(joursConge);
      compteur.jours_reserves = Math.max(0, safeNumber(compteur.jours_reserves) - safeNumber(joursConge));
      await compteur.save({ transaction: t });

      // Notification à l'employé
      if (leaveRules.notification_settings.on_validate) {
        await notificationService.sendEmail({
          to: utilisateur.email,
          subject: 'Votre demande de conge est approuvee',
          templateName: 'leave-approved-employee',
          data: {
            destinataire_prenom: utilisateur.prenom || 'Collaborateur',
            date_debut: conge.date_debut,
            date_fin: conge.date_fin,
            action_url: buildCongeUrl(conge.id),
          }
        });
        await notificationService.creerNotification({
          entreprise_id: conge.entreprise_id,
          utilisateur_id: utilisateur.id,
          type: 'conge_valide_final',
          message: `Votre congé du ${conge.date_debut} au ${conge.date_fin} a été approuvé`,
          url: `/conges/${conge.id}`
        });
      }

      // Audit
      await auditConge.approved(conge, reqUser, req);
    } else {
      throw new Error('Action non autorisée');
    }

    return conge;
  });
}

// ----------------------------
// Refuser un congé
// ----------------------------
async function rejeterConge(congeId, reqUser, commentaire = null, req = null) {
  return sequelize.transaction(async (t) => {
    const conge = await Conge.findByPk(congeId, {
      include: [{ model: CongeType, as: 'conge_type' }],
      transaction: t
    });
    if (!conge) throw new Error('Congé introuvable');
    const joursConge = await resolveCongeDays(conge);
    const baseLeaveRules = await getEntrepriseLeaveRules(conge.entreprise_id, t);

    const utilisateur = await Utilisateur.findByPk(conge.utilisateur_id, { transaction: t });
    const leaveRules = getEffectiveLeaveRules(baseLeaveRules, utilisateur?.service || null);
    const ancienStatut = conge.statut;

    if (reqUser.role === 'manager') {
      if (ancienStatut !== 'en_attente_manager') throw new Error('Impossible de refuser ce congé');
      conge.statut = 'refuse_manager';
      conge.commentaire_manager = commentaire;
    } else if (reqUser.role === 'admin_entreprise' || reqUser.role === 'super_admin') {
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
      if (ancienStatut === 'valide_final') {
        compteur.jours_acquis = safeNumber(compteur.jours_acquis) + safeNumber(joursConge);
        compteur.jours_pris = Math.max(0, safeNumber(compteur.jours_pris) - safeNumber(joursConge));
      } else {
        compteur.jours_reserves = Math.max(0, safeNumber(compteur.jours_reserves) - safeNumber(joursConge));
      }
      await compteur.save({ transaction: t });
    }

    // Notification à l'employé
    if (leaveRules.notification_settings.on_reject) {
      await notificationService.sendEmail({
        to: utilisateur.email,
        subject: 'Votre demande de conge a ete refusee',
        templateName: 'leave-rejected-employee',
        data: {
          destinataire_prenom: utilisateur.prenom || 'Collaborateur',
          date_debut: conge.date_debut,
          date_fin: conge.date_fin,
          commentaire: commentaire || conge.commentaire_admin || conge.commentaire_manager || 'Aucun commentaire',
          action_url: buildCongeUrl(conge.id),
        }
      });
      await notificationService.creerNotification({
        entreprise_id: conge.entreprise_id,
        utilisateur_id: utilisateur.id,
        type: 'conge_refuse',
        message: `Votre congé du ${conge.date_debut} au ${conge.date_fin} a été refusé`,
        url: `/conges/${conge.id}`
      });
    }

    // Audit
    await auditConge.rejected(conge, reqUser, req);

    return conge;
  });
}

// ----------------------------
// Liste et détails
// ----------------------------
async function getConges(user) {
  const where = {};
  if (user.role === 'employe') {
    where.utilisateur_id = user.id;
  } else if (user.role === 'manager' || user.role === 'admin_entreprise') {
    where.entreprise_id = user.entreprise_id;
  }

  const conges = await Conge.findAll({
    where,
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

  if (conges.length === 0) {
    return [];
  }

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
        const joursFeriesSet = new Set((joursFeries || []).map((jf) => buildDateKey(jf.date)));
        joursFeriesByEntreprise.set(entrepriseId, joursFeriesSet);
      } catch (_err) {
        leaveRulesByEntreprise.set(entrepriseId, {});
        blockedDaysByEntreprise.set(entrepriseId, {});
        joursFeriesByEntreprise.set(entrepriseId, new Set());
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

  return conges.map((conge) => {
    const plainConge = conge.toJSON();
    const annee = dayjs(conge.date_debut).year();
    const compteurKey = `${conge.utilisateur_id}::${conge.conge_type_id}::${annee}`;
    const joursFeriesSet = joursFeriesByEntreprise.get(conge.entreprise_id) || new Set();
    const blockedDays = blockedDaysByEntreprise.get(conge.entreprise_id) || {};
    const entrepriseLeaveRules = leaveRulesByEntreprise.get(conge.entreprise_id) || {};
    const effectiveLeaveRules = getEffectiveLeaveRules(entrepriseLeaveRules, plainConge.utilisateur?.service || null);
    const joursPris = Number.parseFloat(plainConge.jours_calcules);
    const joursPrisValue = Number.isFinite(joursPris)
      ? joursPris
      : calculateBusinessDays(conge, joursFeriesSet, blockedDays);

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
  if (!conge) throw new Error('Congé introuvable');
  if (user.role !== 'super_admin' && user.entreprise_id !== conge.entreprise_id && user.id !== conge.utilisateur_id)
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

  let joursFeriesSet = new Set();
  let blockedDays = {};
  let effectiveApprovalWorkflow = null;
  try {
    const leaveRules = await getEntrepriseLeaveRules(conge.entreprise_id);
    blockedDays = leaveRules.blocked_days || {};
    effectiveApprovalWorkflow = getEffectiveLeaveRules(leaveRules, conge.utilisateur?.service || null)?.approval_workflow || null;
    const joursFeries = await joursFeriesService.getJoursFeriesEntreprise(conge.entreprise_id);
    joursFeriesSet = new Set((joursFeries || []).map((jf) => buildDateKey(jf.date)));
  } catch (_err) {
    blockedDays = {};
    effectiveApprovalWorkflow = null;
    joursFeriesSet = new Set();
  }

  const plainConge = conge.toJSON();
  const joursPris = Number.parseFloat(plainConge.jours_calcules);
  const leaveBreakdown = calculateLeaveBreakdown(conge, joursFeriesSet, blockedDays);
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
async function updateConge(id, data, user) {
  return sequelize.transaction(async (t) => {
    const conge = await Conge.findByPk(id, { transaction: t, lock: t.LOCK.UPDATE });
    if (!conge) throw new Error('Congé introuvable');

    const employe = await Utilisateur.findByPk(conge.utilisateur_id, {
      transaction: t,
      attributes: ['id', 'prenom', 'nom', 'email']
    });
    if (!employe) throw new Error('Employé introuvable');

    if (user?.role !== 'admin_entreprise' && user?.id !== conge.utilisateur_id) {
      throw new Error('Modification non autorisée');
    }

    if (user?.role === 'admin_entreprise' && user?.entreprise_id !== conge.entreprise_id) {
      throw new Error('Accès interdit: entreprise différente');
    }

    const isPending = conge.statut === 'en_attente_manager';
    const isFinalValidated = conge.statut === 'valide_final';

    if (!isPending && !isFinalValidated) {
      throw new Error('Modification impossible');
    }

    if (isFinalValidated && user?.role !== 'admin_entreprise') {
      throw new Error('Seul un admin entreprise peut modifier un congé validé');
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
      if (field in data) updates[field] = data[field];
    }

    const nextDateDebut = updates.date_debut ?? conge.date_debut;
    const nextDateFin = updates.date_fin ?? conge.date_fin;
    const nextDebutDemiJournee = updates.debut_demi_journee ?? conge.debut_demi_journee;
    const nextFinDemiJournee = updates.fin_demi_journee ?? conge.fin_demi_journee;
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

    const oldDays = await resolveCongeDays(conge);
    const newDays = await calcJoursConges(
      conge.entreprise_id,
      nextDateDebut,
      nextDateFin,
      nextDebutDemiJournee,
      nextFinDemiJournee
    );

    if (!Number.isFinite(newDays) || newDays <= 0) {
      throw new Error('Nombre de jours de congé invalide');
    }

    const oldYear = dayjs(conge.date_debut).year();
    const nextYear = dayjs(nextDateDebut).year();

    const oldCounter = await CompteurConges.findOne({
      where: {
        utilisateur_id: conge.utilisateur_id,
        conge_type_id: conge.conge_type_id,
        annee: oldYear
      },
      transaction: t,
      lock: t.LOCK.UPDATE
    });

    if (!oldCounter) {
      throw new Error('Compteur de congés introuvable pour modification');
    }

    const nextCongeType = await CongeType.findOne({
      where: { id: nextCongeTypeId, entreprise_id: conge.entreprise_id },
      transaction: t
    });
    if (!nextCongeType) throw new Error('Type de congé introuvable');

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

    if (isPending) {
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

    if (isPending) {
      if (sameCounter) {
        oldCounter.jours_reserves = Math.max(
          0,
          safeNumber(oldCounter.jours_reserves) - safeNumber(oldDays)
        ) + safeNumber(newDays);
        await oldCounter.save({ transaction: t });
      } else {
        oldCounter.jours_reserves = Math.max(0, safeNumber(oldCounter.jours_reserves) - safeNumber(oldDays));
        nextCounter.jours_reserves = safeNumber(nextCounter.jours_reserves) + safeNumber(newDays);
        await oldCounter.save({ transaction: t });
        await nextCounter.save({ transaction: t });
      }
    } else {
      if (sameCounter) {
        // Pour un congé déjà validé, l'admin entreprise peut appliquer un delta signé.
        // Le solde peut donc évoluer à la hausse ou à la baisse selon la modification.
        oldCounter.jours_acquis =
          safeNumber(oldCounter.jours_acquis) + safeNumber(oldDays) - safeNumber(newDays);
        oldCounter.jours_pris =
          safeNumber(oldCounter.jours_pris) - safeNumber(oldDays) + safeNumber(newDays);
        await oldCounter.save({ transaction: t });
      } else {
        oldCounter.jours_acquis = safeNumber(oldCounter.jours_acquis) + safeNumber(oldDays);
        oldCounter.jours_pris = Math.max(0, safeNumber(oldCounter.jours_pris) - safeNumber(oldDays));

        nextCounter.jours_acquis = safeNumber(nextCounter.jours_acquis) - safeNumber(newDays);
        nextCounter.jours_pris = safeNumber(nextCounter.jours_pris) + safeNumber(newDays);

        await oldCounter.save({ transaction: t });
        await nextCounter.save({ transaction: t });
      }
    }

    await conge.update({
      ...updates,
      jours_calcules: newDays
    }, { transaction: t });

    if (isFinalValidated && user?.role === 'admin_entreprise') {
      const adminNom = `${user?.prenom || ''} ${user?.nom || ''}`.trim() || 'Administrateur';
      if (employe.email) {
        await notificationService.sendEmail({
          to: employe.email,
          subject: 'Mise a jour de votre conge valide',
          templateName: 'leave-updated-employee',
          data: {
            destinataire_prenom: employe.prenom || 'Collaborateur',
            auteur_action: adminNom,
            ancienne_periode: `${conge.date_debut} au ${conge.date_fin}`,
            nouvelle_periode: `${nextDateDebut} au ${nextDateFin}`,
            action_url: buildCongeUrl(conge.id),
          }
        });
      }
      await notificationService.creerNotification({
        entreprise_id: conge.entreprise_id,
        utilisateur_id: employe.id,
        type: 'conge_modifie_admin',
        message: `Votre congé du ${conge.date_debut} au ${conge.date_fin} a été modifié par ${adminNom} (nouvelle période : ${nextDateDebut} au ${nextDateFin})`,
        url: `/conges/${conge.id}`
      });
    }

    return conge;
  });
}

async function deleteConge(id, user) {
  await sequelize.transaction(async (t) => {
    const conge = await Conge.findByPk(id, { transaction: t, lock: t.LOCK.UPDATE });
    if (!conge) throw new Error('Congé introuvable');

    const employe = await Utilisateur.findByPk(conge.utilisateur_id, {
      attributes: ['id', 'prenom', 'nom', 'email'],
      transaction: t,
    });
    if (!employe) throw new Error('Employé introuvable');

    if (user?.role !== 'admin_entreprise' && user?.id !== conge.utilisateur_id) {
      throw new Error('Suppression non autorisée');
    }

    if (user?.role === 'admin_entreprise' && user?.entreprise_id !== conge.entreprise_id) {
      throw new Error('Accès interdit: entreprise différente');
    }

    const isPending = conge.statut === 'en_attente_manager';
    const isFinalValidated = conge.statut === 'valide_final';

    if (!isPending && !isFinalValidated) throw new Error('Impossible de supprimer');
    if (isFinalValidated && user?.role !== 'admin_entreprise') {
      throw new Error('Seul un admin entreprise peut annuler un congé validé');
    }

    const joursConge = await resolveCongeDays(conge);

    const compteur = await CompteurConges.findOne({
      where: { utilisateur_id: conge.utilisateur_id, conge_type_id: conge.conge_type_id, annee: dayjs(conge.date_debut).year() },
      transaction: t,
      lock: t.LOCK.UPDATE,
    });

    // Évite les suppressions silencieuses sans rollback de solde.
    if (!compteur) {
      throw new Error('Compteur introuvable pour annulation: aucune mise à jour de solde appliquée');
    }

    if (isPending) {
      compteur.jours_reserves = Math.max(0, safeNumber(compteur.jours_reserves) - safeNumber(joursConge));
    } else {
      compteur.jours_acquis = safeNumber(compteur.jours_acquis) + safeNumber(joursConge);
      compteur.jours_pris = Math.max(0, safeNumber(compteur.jours_pris) - safeNumber(joursConge));
      compteur.jours_annules = safeNumber(compteur.jours_annules) + safeNumber(joursConge);
    }
    await compteur.save({ transaction: t });

    if (isFinalValidated && user?.role === 'admin_entreprise') {
      const adminNom = `${user?.prenom || ''} ${user?.nom || ''}`.trim() || 'Administrateur';
      if (employe.email) {
        await notificationService.sendEmail({
          to: employe.email,
          subject: 'Annulation de votre conge valide',
          templateName: 'leave-cancelled-employee',
          data: {
            destinataire_prenom: employe.prenom || 'Collaborateur',
            auteur_action: adminNom,
            date_debut: conge.date_debut,
            date_fin: conge.date_fin,
            action_url: buildCongeUrl(conge.id),
          }
        });
      }
      await notificationService.creerNotification({
        entreprise_id: conge.entreprise_id,
        utilisateur_id: employe.id,
        type: 'conge_annule_admin',
        message: `Votre congé du ${conge.date_debut} au ${conge.date_fin} a été annulé par ${adminNom}`,
        url: `/conges/${conge.id}`
      });
    }

    await conge.destroy({ transaction: t });
  });
}

module.exports = {
  checkOverlapConge,
  createConge,
  getConges,
  getCongeById,
  updateConge,
  deleteConge,
  validerConge,
  rejeterConge,
  calcJoursConges
};