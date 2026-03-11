const { sequelize } = require('../models');

/**
 * Lecture du calendrier des congés via la vue SQL
 * Query params optionnels :
 *  - entrepriseId : UUID
 *  - statut : 'en_attente_manager' | 'valide_manager' | 'valide_final' | 'refuse_final'
 *  - utilisateurId : UUID
 */
async function getCalendrier(req, res) {
  try {
    let query = `SELECT * FROM vue_calendrier_conges WHERE 1=1`;
    const replacements = {};

    if (req.query.entrepriseId) {
      query += ` AND utilisateur_id IN (
        SELECT id FROM utilisateur WHERE entreprise_id = :entrepriseId
      )`;
      replacements.entrepriseId = req.query.entrepriseId;
    }

    if (req.query.statut) {
      query += ` AND statut = :statut`;
      replacements.statut = req.query.statut;
    }

    if (req.query.utilisateurId) {
      query += ` AND utilisateur_id = :utilisateurId`;
      replacements.utilisateurId = req.query.utilisateurId;
    }

    query += ` ORDER BY date_debut`;

    const [results] = await sequelize.query(query, { replacements });
    res.json(results);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: err.message });
  }
}

module.exports = { getCalendrier };