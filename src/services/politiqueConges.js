/**
 * Récupère la politique de congé pour un type
 */
function getPolitiqueType(entreprise, codeConge) {
  const politique = entreprise.politique_conges?.[codeConge] ?? {};
  return {
    solde_negatif_autorise: politique.solde_negatif_autorise ?? false,
    report: politique.report ?? false,
    max_report: politique.max_report ?? 0,
  };
}

/**
 * Calcul du solde avec report
 */
function calculSoldeAvecReport(solde, politique) {
  if (!politique.report) return solde;
  return solde > politique.max_report ? politique.max_report : solde;
}

/**
 * Vérifie si l'utilisateur peut poser le congé
 */
function peutPoser(solde, joursDemandes, politique) {
  solde = Number(solde) || 0;
  joursDemandes = Number(joursDemandes) || 0;
  return solde - joursDemandes >= 0 || politique.solde_negatif_autorise;
}

/**
 * Récupère toutes les politiques d'une entreprise
 */
function getToutesPolitiques(entreprise) {
  return entreprise.politique_conges ?? {};
}

module.exports = {
  getPolitiqueType,
  calculSoldeAvecReport,
  peutPoser,
  getToutesPolitiques,
};