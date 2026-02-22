function getPolitiqueType(entreprise, codeConge) {
  const politique = entreprise.politique_conges?.[codeConge];

  if (!politique) {
    // Valeurs par défaut si aucune politique définie
    return {
      solde_negatif_autorise: false,
      report: false,
      max_report: 0,
    };
  }

  // Sécurisation / valeurs par défaut pour chaque propriété
  return {
    solde_negatif_autorise: politique.solde_negatif_autorise ?? false,
    report: politique.report ?? false,
    max_report: politique.max_report ?? 0,
    // Tu peux ajouter d'autres règles ici si nécessaire
  };
}

// Vérifie si l'utilisateur peut poser le congé en fonction de son solde et de la politique
function peutPoser(soldeActuel, joursDemandes, politique) {
  if (soldeActuel - joursDemandes < 0 && !politique.solde_negatif_autorise) {
    return false;
  }
  return true;
}

// Calcule le solde en tenant compte du report autorisé par la politique
function calculSoldeAvecReport(soldeActuel, politique) {
  if (!politique.report) return soldeActuel;
  const maxReport = politique.max_report ?? 0;
  return soldeActuel > maxReport ? maxReport : soldeActuel;
}


// Récupère toutes les politiques de congés d'une entreprise
function getToutesPolitiques(entreprise) {
  return entreprise.politique_conges ?? {};
}

module.exports = {
  getPolitiqueType,
  getToutesPolitiques,
  peutPoser,
  calculSoldeAvecReport,
};
