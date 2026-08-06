const { MouvementSolde } = require('../models');
const logger = require('../utils/logger');

const LABELS = {
  credit_initial:        'Ouverture de compte',
  credit_mensuel:        'Crédit mensuel',
  report_annee:          'Report année précédente',
  reservation:           'Congé posé (en attente)',
  validation_auto:       'Congé validé (automatique)',
  validation:            'Congé validé',
  rejet:                 'Congé refusé',
  annulation:            'Congé annulé',
  activation_reservation:'Réservation N+1 activée',
  ajustement_admin:      'Ajustement administratif',
};

/**
 * Enregistre un mouvement de solde.
 *
 * @param {object} params
 * @param {string} params.entreprise_id
 * @param {string} params.utilisateur_id
 * @param {string} params.conge_type_id
 * @param {number} params.annee
 * @param {string} params.type          — une des clés de LABELS
 * @param {number} params.quantite      — delta sur solde_disponible (+/-)
 * @param {number} params.solde_apres   — solde_disponible = acquis - reserves après l'événement
 * @param {string} [params.source_id]   — conge.id si applicable
 * @param {string} [params.description] — remplace le libellé par défaut
 * @param {Date}   [params.date]        — date de l'événement (défaut: now)
 * @param {object} [params.transaction] — transaction Sequelize active
 */
async function logMouvement({ entreprise_id, utilisateur_id, conge_type_id, annee, type, quantite, solde_apres, source_id = null, description = null, date = null, transaction = null }) {
  try {
    await MouvementSolde.create({
      entreprise_id,
      utilisateur_id,
      conge_type_id,
      annee,
      date: date || new Date(),
      type,
      quantite: Number(quantite),
      solde_apres: Number(solde_apres),
      source_id: source_id || null,
      description: description || LABELS[type] || type,
    }, transaction ? { transaction } : {});
  } catch (err) {
    logger.error('logMouvement error', { error: err.message, type, utilisateur_id });
  }
}

/**
 * Construit la description avec la période du congé.
 */
function descriptionConge(label, dateDebut, dateFin) {
  if (!dateDebut) return label;
  const fmt = (d) => new Date(d).toLocaleDateString('fr-FR');
  return `${label} · ${fmt(dateDebut)}${dateFin && dateFin !== dateDebut ? ' – ' + fmt(dateFin) : ''}`;
}

module.exports = { logMouvement, descriptionConge, LABELS };
