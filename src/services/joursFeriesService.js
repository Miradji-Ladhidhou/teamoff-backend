const { JoursFeries } = require('../models');

async function getJoursFeriesEntreprise(entrepriseId) {
  return JoursFeries.findAll({ where: { entreprise_id: entrepriseId } });
}

function estJourFerie(date, joursFeries) {
  const d = new Date(date);
  const jour = d.getDate();
  const mois = d.getMonth();
  return joursFeries.some(jf => {
    const jfDate = new Date(jf.date);
    if (jf.recurrent) return jfDate.getDate() === jour && jfDate.getMonth() === mois;
    return jfDate.toISOString().split('T')[0] === date;
  });
}

module.exports = {
  getJoursFeriesEntreprise,
  estJourFerie,
};