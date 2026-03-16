const { JoursFeries } = require('../models');

/**
 * Liste tous les jours fériés d'une entreprise
 */
async function getJoursFeriesEntreprise(entrepriseId) {
  return JoursFeries.findAll({ where: { entreprise_id: entrepriseId } });
}

/**
 * Vérifie si une date est un jour férié
 * @param {string} date - 'YYYY-MM-DD'
 * @param {Array} joursFeries - tableau d'objets JoursFeries
 */
function estJourFerie(date, joursFeries) {
  const [y, m, d] = date.split('-').map(Number);

  return joursFeries.some(jf => {
    if (jf.est_travail) {
      return false;
    }

    const jfDate = new Date(jf.date);
    if (jf.recurrent) {
      return jfDate.getUTCDate() === d && jfDate.getUTCMonth() === (m - 1);
    }
    // comparaison stricte YYYY-MM-DD
    const jfStr = jfDate.toISOString().slice(0, 10);
    return jfStr === date;
  });
}

module.exports = {
  getJoursFeriesEntreprise,
  estJourFerie,
};