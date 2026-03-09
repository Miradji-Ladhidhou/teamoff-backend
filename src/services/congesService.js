// services/congesService.js
const { Conge, CompteurConges, CongeType, Utilisateur, sequelize } = require('../models');
const { Op } = require('sequelize');
const { getJoursFeriesEntreprise, estJourFerie } = require('./joursFeriesService');
const { getPolitiqueType, calculSoldeAvecReport, peutPoser } = require('./politiqueConges');

/**
 * Calcul des jours de congé hors weekend et jours fériés
 */
async function calcJoursConges(entrepriseId, dateDebut, dateFin, debut_demi, fin_demi) {
  if (new Date(dateFin) < new Date(dateDebut)) throw new Error("date_fin invalide");

  const joursFeries = await getJoursFeriesEntreprise(entrepriseId);
  let total = 0;
  let current = new Date(dateDebut);
  const fin = new Date(dateFin);

  while (current <= fin) {
    const jourSemaine = current.getDay();
    const isWeekend = jourSemaine === 0 || jourSemaine === 6;
    const isFerie = estJourFerie(current.toISOString().split('T')[0], joursFeries);
    if (!isWeekend && !isFerie) total += 1;
    current.setDate(current.getDate() + 1);
  }

  if (total > 0) {
    if (debut_demi === 'apres_midi') total -= 0.5;
    if (fin_demi === 'matin') total -= 0.5;
  }

  return total;
}

/**
 * Crée un congé et met à jour le compteur
 */
async function creerConge({
  utilisateur_id, conge_type_id, date_debut, date_fin, debut_demi_journee, fin_demi_journee, reqUser
}) {
  return await sequelize.transaction(async (t) => {
    const utilisateur = await Utilisateur.findByPk(utilisateur_id, { include: ['entreprise'], transaction: t });
    if (!utilisateur) throw new Error('Utilisateur introuvable');

    if (reqUser.role !== 'super_admin' && reqUser.entreprise_id !== utilisateur.entreprise_id)
      throw new Error('Accès interdit : entreprise différente');

    const congeType = await CongeType.findByPk(conge_type_id, { transaction: t });
    if (!congeType || congeType.entreprise_id !== utilisateur.entreprise_id)
      throw new Error('Type de congé introuvable ou entreprise différente');

    const politique = getPolitiqueType(utilisateur.entreprise, congeType.code);
    const annee = new Date(date_debut).getFullYear();

    let compteur = await CompteurConges.findOne({
      where: { utilisateur_id, conge_type_id, annee },
      transaction: t,
      lock: t.LOCK.UPDATE
    });
    if (!compteur) {
      compteur = await CompteurConges.create({
        utilisateur_id,
        conge_type_id,
        entreprise_id: utilisateur.entreprise_id,
        annee,
        jours_acquis: congeType.quota_annuel ?? 0,
        jours_pris: 0
      }, { transaction: t });
    }

    // Vérification chevauchement
    const chevauche = await Conge.findOne({
      where: {
        utilisateur_id,
        statut: ['en_attente_manager', 'valide_manager', 'valide_final'],
        date_debut: { [Op.lte]: date_fin },
        date_fin: { [Op.gte]: date_debut }
      },
      transaction: t
    });
    if (chevauche) throw new Error('Chevauchement de congés détecté');

    const jours_a_prendre = await calcJoursConges(
      utilisateur.entreprise_id,
      date_debut,
      date_fin,
      debut_demi_journee,
      fin_demi_journee
    );

    const solde_disponible = calculSoldeAvecReport(
      parseFloat(compteur.jours_acquis - compteur.jours_pris),
      politique
    );

    if (!peutPoser(solde_disponible, jours_a_prendre, politique))
      throw new Error('Solde insuffisant pour ce congé');

    const conge = await Conge.create({
      utilisateur_id,
      entreprise_id: utilisateur.entreprise_id,
      conge_type_id,
      date_debut,
      date_fin,
      debut_demi_journee,
      fin_demi_journee,
      statut: 'en_attente_manager'
    }, { transaction: t });

    compteur.jours_pris += jours_a_prendre;
    await compteur.save({ transaction: t });

    return conge;
  });
}

module.exports = {
  creerConge,
  calcJoursConges,
  getJoursFeriesEntreprise,
  estJourFerie,
  getPolitiqueType,
  calculSoldeAvecReport,
  peutPoser
};