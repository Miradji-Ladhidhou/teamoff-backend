// services/congesService.js

const { Conge, CompteurConges, CongeType, Utilisateur, sequelize } = require('../models');
const { Op } = require('sequelize');
const { getJoursFeriesEntreprise, estJourFerie } = require('./joursFeriesService');
const { getPolitiqueType, peutPoser } = require('./politiqueConges');


/**
 * Calcul des jours de congé hors weekend et jours fériés
 */
async function calcJoursConges(entrepriseId, dateDebut, dateFin, debut_demi, fin_demi) {

  const start = new Date(dateDebut);
  const end = new Date(dateFin);

  if (end < start) throw new Error("date_fin invalide");

  const joursFeries = await getJoursFeriesEntreprise(entrepriseId);

  let total = 0;

  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {

    const day = d.getDay();
    const dateStr = d.toISOString().slice(0, 10);

    if (day !== 0 && day !== 6 && !estJourFerie(dateStr, joursFeries)) {
      total++;
    }
  }

  if (total > 0) {
    if (debut_demi === 'apres_midi') total -= 0.5;
    if (fin_demi === 'matin') total -= 0.5;
  }

  return total;
}


/**
 * Création d'une demande de congé
 */
async function creerConge({
  utilisateur_id,
  conge_type_id,
  date_debut,
  date_fin,
  debut_demi_journee,
  fin_demi_journee,
  reqUser
}) {

  return sequelize.transaction(async (t) => {

    const utilisateur = await Utilisateur.findByPk(utilisateur_id, {
      include: ['entreprise'],
      transaction: t
    });

    if (!utilisateur) throw new Error("Utilisateur introuvable");

    if (reqUser.role !== 'super_admin' &&
        reqUser.entreprise_id !== utilisateur.entreprise_id) {
      throw new Error("Accès interdit");
    }

    const congeType = await CongeType.findByPk(conge_type_id, { transaction: t });

    if (!congeType || congeType.entreprise_id !== utilisateur.entreprise_id) {
      throw new Error("Type de congé invalide");
    }

    const politique = getPolitiqueType(utilisateur.entreprise, congeType.code);

    const annee = new Date(date_debut).getFullYear();


    // -----------------------
    // récupération compteur
    // -----------------------

    let compteur = await CompteurConges.findOne({
      where: { utilisateur_id, conge_type_id, annee },
      transaction: t,
      lock: t.LOCK.UPDATE
    });

    if (!compteur) {

      compteur = await CompteurConges.create({
        utilisateur_id,
        entreprise_id: utilisateur.entreprise_id,
        conge_type_id,
        annee,
        jours_acquis: congeType.quota_annuel ?? 0,
        jours_pris: 0,
        jours_reserves: 0
      }, { transaction: t });

    }


    // -----------------------
    // chevauchement congés
    // -----------------------

    const chevauche = await Conge.findOne({
      where: {
        utilisateur_id,
        statut: ['en_attente_manager', 'valide_manager', 'valide_final'],
        date_debut: { [Op.lte]: date_fin },
        date_fin: { [Op.gte]: date_debut }
      },
      transaction: t
    });

    if (chevauche) throw new Error("Chevauchement de congés détecté");


    // -----------------------
    // calcul jours
    // -----------------------

    const jours = await calcJoursConges(
      utilisateur.entreprise_id,
      date_debut,
      date_fin,
      debut_demi_journee,
      fin_demi_journee
    );


    // -----------------------
    // vérification solde
    // -----------------------

    const solde = compteur.getSoldeTotal() - parseFloat(compteur.jours_reserves);

    if (!peutPoser(solde, jours, politique)) {
      throw new Error("Solde insuffisant");
    }


    // -----------------------
    // réservation quota
    // -----------------------

    compteur.jours_reserves =
      parseFloat(compteur.jours_reserves) + parseFloat(jours);

    await compteur.save({ transaction: t });


    // -----------------------
    // création congé
    // -----------------------

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

    return conge;

  });

}


/**
 * Validation finale d'un congé
 */
async function validerConge(congeId) {

  return sequelize.transaction(async (t) => {

    const conge = await Conge.findByPk(congeId, { transaction: t });

    if (!conge) throw new Error("Congé introuvable");


    const compteur = await CompteurConges.findOne({

      where: {
        utilisateur_id: conge.utilisateur_id,
        conge_type_id: conge.conge_type_id,
        annee: new Date(conge.date_debut).getFullYear()
      },

      transaction: t,
      lock: t.LOCK.UPDATE

    });


    const jours = conge.jours_calcules;


    compteur.jours_reserves =
      parseFloat(compteur.jours_reserves) - parseFloat(jours);

    compteur.jours_pris =
      parseFloat(compteur.jours_pris) + parseFloat(jours);


    await compteur.save({ transaction: t });


    conge.statut = "valide_final";

    await conge.save({ transaction: t });


    return conge;

  });

}


module.exports = {

  creerConge,
  validerConge,
  calcJoursConges

};