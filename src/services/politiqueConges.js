// Centralise toutes les règles de congés
function getPolitiqueType(entreprise, codeConge) {
  const politique = entreprise.politique_conges?.[codeConge] ?? {};
  return {
    solde_negatif_autorise: politique.solde_negatif_autorise ?? false,
    report: politique.report ?? false,
    max_report: politique.max_report ?? 0,
  };
}

function calculSoldeAvecReport(solde, politique) {
  if (!politique.report) return solde;
  return solde > politique.max_report ? politique.max_report : solde;
}

function peutPoser(solde, joursDemandes, politique) {
  return solde - joursDemandes >= 0 || politique.solde_negatif_autorise;
}

function getToutesPolitiques(entreprise) {
  return entreprise.politique_conges ?? {};
}

module.exports = {
  getPolitiqueType,
  calculSoldeAvecReport,
  peutPoser,
  getToutesPolitiques,
};