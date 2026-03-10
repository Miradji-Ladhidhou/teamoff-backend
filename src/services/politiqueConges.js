/**
 * Récupère la politique de congé pour un type
 * @param {Object} entreprise - objet entreprise Sequelize
 * @param {string} codeConge - code du type de congé
 */
function getPolitiqueType(entreprise, codeConge) {
  const politique = entreprise?.politique_conges?.[codeConge] ?? {};
  return {
    solde_negatif_autorise: Boolean(politique.solde_negatif_autorise),
    report: Boolean(politique.report),
    max_report: Number(politique.max_report) || 0,
  };
}

/**
 * Calcul du solde disponible en tenant compte du report
 * @param {number} solde - solde actuel
 * @param {Object} politique - objet politique
 */
function calculSoldeAvecReport(solde, politique) {
  solde = Number(solde) || 0;
  if (!politique?.report) return solde;
  return solde > politique.max_report ? politique.max_report : solde;
}

/**
 * Vérifie si l'utilisateur peut poser le congé
 * @param {number} solde - solde disponible
 * @param {number} joursDemandes - nombre de jours demandés
 * @param {Object} politique - objet politique
 */
function peutPoser(solde, joursDemandes, politique) {
  solde = Number(solde) || 0;
  joursDemandes = Number(joursDemandes) || 0;
  return solde - joursDemandes >= 0 || Boolean(politique?.solde_negatif_autorise);
}

/**
 * Récupère toutes les politiques d'une entreprise
 * @param {Object} entreprise
 */
function getToutesPolitiques(entreprise) {
  return entreprise?.politique_conges ?? {};
}

module.exports = {
  getPolitiqueType,
  calculSoldeAvecReport,
  peutPoser,
  getToutesPolitiques,
};