const { Conge, CompteurConges, CongeType, Utilisateur, sequelize } = require('../models');
const { Op } = require('sequelize');
const { getJoursFeriesEntreprise, estJourFerie } = require('./joursFeriesService');
const { getPolitiqueType, peutPoser } = require('./politiqueConges');
const notificationService = require('./notificationService');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');

dayjs.extend(utc);
dayjs.extend(timezone);

/**
 * Calcul des jours de congé hors weekends et jours fériés
 */
async function calcJoursConges(entrepriseId, dateDebut, dateFin, debut_demi, fin_demi, tz = 'UTC') {
  const start = dayjs(dateDebut).tz(tz).startOf('day');
  const end = dayjs(dateFin).tz(tz).startOf('day');

  if (end.isBefore(start)) throw new Error("date_fin invalide");

  const joursFeries = await getJoursFeriesEntreprise(entrepriseId);
  let total = 0;

  for (let d = start; d.isSameOrBefore(end, 'day'); d = d.add(1, 'day')) {
    const day = d.day();
    const dateStr = d.format('YYYY-MM-DD');
    if (day !== 0 && day !== 6 && !estJourFerie(dateStr, joursFeries)) total++;
  }

  if (total > 0) {
    if (debut_demi === 'apres_midi') total -= 0.5;
    if (fin_demi === 'matin') total -= 0.5;
  }

  return total;
}

/**
 * Création ou récupération du compteur
 */
async function getOrCreateCompteur(utilisateur_id, conge_type_id, entreprise_id, annee, quota, transaction) {
  let compteur = await CompteurConges.findOne({
    where: { utilisateur_id, conge_type_id, annee },
    transaction,
    lock: transaction.LOCK.UPDATE
  });

  if (!compteur) {
    compteur = await CompteurConges.create({
      utilisateur_id,
      entreprise_id,
      conge_type_id,
      annee,
      jours_acquis: quota ?? 0,
      jours_pris: 0,
      jours_reserves: 0
    }, { transaction });
  }

  return compteur;
}

/**
 * Création d'une demande de congé
 */
async function creerConge({ utilisateur_id, conge_type_id, date_debut, date_fin, debut_demi_journee, fin_demi_journee, reqUser }) {
  return sequelize.transaction(async (t) => {
    // --- Utilisateur + entreprise
    const utilisateur = await Utilisateur.findByPk(utilisateur_id, {
      include: ['entreprise'],
      transaction: t
    });
    if (!utilisateur) throw new Error("Utilisateur introuvable");

    if (reqUser.role !== 'super_admin' && reqUser.entreprise_id !== utilisateur.entreprise_id) {
      throw new Error("Accès interdit");
    }

    const entrepriseTimezone = utilisateur.entreprise.parametres?.timezone || 'UTC';

    // --- Type de congé
    const congeType = await CongeType.findByPk(conge_type_id, { transaction: t });
    if (!congeType || congeType.entreprise_id !== utilisateur.entreprise_id) {
      throw new Error("Type de congé invalide");
    }

    const politiqueEntreprise = utilisateur.entreprise.politique_conges || {};
    const politique = getPolitiqueType(utilisateur.entreprise, congeType.code);
    const annee = dayjs(date_debut).tz(entrepriseTimezone).year();

    // --- Vérification délai préavis
    if (politiqueEntreprise.delai_preavis_jours) {
      const today = dayjs().tz(entrepriseTimezone).startOf('day');
      const startDate = dayjs(date_debut).tz(entrepriseTimezone).startOf('day');
      if (startDate.diff(today, 'day') < politiqueEntreprise.delai_preavis_jours) {
        throw new Error(`Le congé doit être posé au moins ${politiqueEntreprise.delai_preavis_jours} jours à l'avance`);
      }
    }

    // --- Calcul jours
    const jours = await calcJoursConges(utilisateur.entreprise_id, date_debut, date_fin, debut_demi_journee, fin_demi_journee, entrepriseTimezone);

    // --- Vérification maximum jours consécutifs
    if (politiqueEntreprise.max_conges_consecutifs && jours > politiqueEntreprise.max_conges_consecutifs) {
      throw new Error(`Maximum ${politiqueEntreprise.max_conges_consecutifs} jours consécutifs autorisés`);
    }

    // --- Chevauchement des congés (demi-journées incluses)
    const chevauche = await Conge.findOne({
      where: {
        utilisateur_id,
        statut: { [Op.in]: ['en_attente_manager', 'valide_manager', 'valide_final'] },
        date_debut: { [Op.lte]: date_fin },
        date_fin: { [Op.gte]: date_debut }
      },
      transaction: t
    });
    if (chevauche) throw new Error("Chevauchement de congés détecté");

    // --- Compteur
    const compteur = await getOrCreateCompteur(utilisateur_id, conge_type_id, utilisateur.entreprise_id, annee, congeType.quota_annuel, t);

    // --- Vérification solde
    const solde = parseFloat(compteur.getSoldeTotal()) - parseFloat(compteur.jours_reserves);
    if (!peutPoser(solde, jours, politique)) throw new Error("Solde insuffisant");

    // --- Réservation quota
    compteur.jours_reserves += jours;
    await compteur.save({ transaction: t });

    // --- Création congé
    const conge = await Conge.create({
      utilisateur_id,
      entreprise_id: utilisateur.entreprise_id,
      conge_type_id,
      date_debut,
      date_fin,
      debut_demi_journee,
      fin_demi_journee,
      jours_calcules: jours,
      statut: "en_attente_manager"
    }, { transaction: t });

    // --- Notification
    await notificationService.creerNotification({
      entreprise_id: utilisateur.entreprise_id,
      utilisateur_id: utilisateur.id,
      type: 'nouveau_conge',
      message: `Votre demande de congé du ${date_debut} au ${date_fin} a été créée et est en attente de validation.`,
      url: `/conges/${conge.id}`
    });

    return conge;
  });
}

/**
 * Validation finale congé
 */
async function validerConge(congeId) {
  return sequelize.transaction(async (t) => {
    const conge = await Conge.findByPk(congeId, { transaction: t });
    if (!conge) throw new Error("Congé introuvable");

    const compteur = await CompteurConges.findOne({
      where: {
        utilisateur_id: conge.utilisateur_id,
        conge_type_id: conge.conge_type_id,
        annee: dayjs(conge.date_debut).year()
      },
      transaction: t,
      lock: t.LOCK.UPDATE
    });

    const jours = conge.jours_calcules;
    compteur.jours_reserves -= jours;
    compteur.jours_pris += jours;
    await compteur.save({ transaction: t });

    conge.statut = "valide_final";
    await conge.save({ transaction: t });

    await notificationService.creerNotification({
      entreprise_id: conge.entreprise_id,
      utilisateur_id: conge.utilisateur_id,
      type: 'conge_valide',
      message: `Votre congé du ${conge.date_debut} au ${conge.date_fin} a été validé.`,
      url: `/conges/${conge.id}`
    });

    return conge;
  });
}

/**
 * Refuser congé
 */
async function refuserConge(congeId, valideParId, raison, t = null) {
  const transaction = t || await sequelize.transaction();

  try {
    const conge = await Conge.findByPk(congeId, { transaction });
    if (!conge) throw new Error("Congé introuvable");

    const compteur = await CompteurConges.findOne({
      where: {
        utilisateur_id: conge.utilisateur_id,
        conge_type_id: conge.conge_type_id,
        annee: dayjs(conge.date_debut).year()
      },
      transaction,
      lock: transaction.LOCK.UPDATE
    });

    const jours = conge.jours_calcules;
    compteur.jours_reserves -= jours;
    await compteur.save({ transaction });

    conge.statut = "refuse_final";
    await conge.save({ transaction });

    await notificationService.creerNotification({
      entreprise_id: conge.entreprise_id,
      utilisateur_id: conge.utilisateur_id,
      type: 'conge_refuse',
      message: `Votre congé du ${conge.date_debut} au ${conge.date_fin} a été refusé. Raison: ${raison}`,
      url: `/conges/${conge.id}`
    });

    if (!t) await transaction.commit();

    return conge;
  } catch (err) {
    if (!t) await transaction.rollback();
    throw err;
  }
}

module.exports = {
  creerConge,
  validerConge,
  refuserConge,
  calcJoursConges
};