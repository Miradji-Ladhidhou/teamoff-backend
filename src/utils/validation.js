const { isUUID } = require('validator');

function validateUUID(id) {
  return isUUID(id);
}

function validateDate(date) {
  if (!date) return false;
  const d = new Date(date);
  return !isNaN(d.getTime()) && /^\d{4}-\d{2}-\d{2}$/.test(date);
}

function validateDateRange(dateDebut, dateFin) {
  return validateDate(dateDebut) && validateDate(dateFin) && new Date(dateFin) >= new Date(dateDebut);
}

function validateDemiJournee(demiJournee) {
  return ['matin', 'apres_midi'].includes(demiJournee);
}

function validateConge(conge) {
  if (!validateUUID(conge.utilisateur_id)) throw new Error('utilisateur_id invalide');
  if (!validateUUID(conge.conge_type_id)) throw new Error('conge_type_id invalide');
  if (!validateDateRange(conge.date_debut, conge.date_fin)) throw new Error('Dates invalides ou date_fin < date_debut');
  if (!validateDemiJournee(conge.debut_demi_journee)) throw new Error('debut_demi_journee invalide');
  if (!validateDemiJournee(conge.fin_demi_journee)) throw new Error('fin_demi_journee invalide');
}

module.exports = {
  validateUUID,
  validateDate,
  validateDateRange,
  validateDemiJournee,
  validateConge
};