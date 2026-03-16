// services/quotasService.js
const { CompteurConges, CongeType, Utilisateur, sequelize } = require('../models');
const { getPolitiqueType } = require('./politiqueConges');

/**
 * Initialise les compteurs pour une année donnée
 */
async function initQuotaAnnuel(entrepriseId, annee) {
  return await sequelize.transaction(async (t) => {
    const utilisateurs = await Utilisateur.findAll({ where: { entreprise_id: entrepriseId }, transaction: t });
    const types = await CongeType.findAll({ where: { entreprise_id: entrepriseId }, transaction: t });

    for (const u of utilisateurs) {
      for (const type of types) {
        const politique = getPolitiqueType(u.entreprise, type.code);
        let compteur = await CompteurConges.findOne({
          where: { utilisateur_id: u.id, conge_type_id: type.id, annee },
          transaction: t
        });

        // Calcul du report si applicable
        let report = 0;
        if (compteur && politique.report) {
          const solde = parseFloat(compteur.jours_acquis) + parseFloat(compteur.jours_reportes) - parseFloat(compteur.jours_pris);
          report = solde > politique.max_report ? politique.max_report : Math.max(0, solde);
        }

        if (compteur) {
          compteur.jours_acquis = type.quota_annuel ?? 0;
          compteur.jours_pris = 0;
          compteur.jours_reportes = report;
          await compteur.save({ transaction: t });
        } else {
          await CompteurConges.create({
            entreprise_id: entrepriseId,
            utilisateur_id: u.id,
            conge_type_id: type.id,
            annee,
            jours_acquis: type.quota_annuel ?? 0,
            jours_pris: 0,
            jours_reportes: report
          }, { transaction: t });
        }
      }
    }
  });
}

/**
 * Ajoute acquisition mensuelle progressive
 * Exemple : quota 30 jours → 2.5 jours/mois
 */
async function ajouterAcquisitionMensuelle(entrepriseId, annee, mois) {
  const compteurs = await CompteurConges.findAll({ where: { entreprise_id: entrepriseId, annee } });
  for (const c of compteurs) {
    const type = await CongeType.findByPk(c.conge_type_id);
    const acquisitionMensuelle = (type.quota_annuel ?? 0) / 12;
    c.jours_acquis = parseFloat(c.jours_acquis) + acquisitionMensuelle;
    await c.save();
  }
}

/**
 * Récupère le solde total d'un utilisateur pour un type de congé
 */
async function getSoldeUtilisateur(utilisateur_id, conge_type_id, annee) {
  const compteur = await CompteurConges.findOne({ where: { utilisateur_id, conge_type_id, annee } });
  return compteur ? compteur.getSoldeDisponible() : 0;
}

/**
 * Récupère tous les soldes d'un utilisateur pour une année
 */
async function getSoldesUtilisateur(utilisateur_id, annee) {
  const compteurs = await CompteurConges.findAll({
    where: { utilisateur_id, annee },
    include: [{ model: require('../models').CongeType, as: 'conge_type' }]
  });

  return compteurs.map(c => ({
    conge_type_id: c.conge_type_id,
    conge_type: c.conge_type.libelle,
    jours_acquis: c.jours_acquis,
    jours_pris: c.jours_pris,
    jours_reportes: c.jours_reportes,
    jours_reserves: c.jours_reserves,
    solde_disponible: c.getSoldeDisponible()
  }));
}

module.exports = {
  initQuotaAnnuel,
  ajouterAcquisitionMensuelle,
  getSoldeUtilisateur,
  getSoldesUtilisateur
};