const { Conge, CongeType, Utilisateur } = require('../models');
const logger = require('../utils/logger');
const { Op } = require('sequelize');
const dayjs = require('dayjs');

/**
 * Retourne les congés visibles selon le rôle de l'utilisateur.
 * Compatible avec :
 *  - GET /calendrier-conges            → tous les congés de l'entreprise
 *  - GET /calendrier-conges/:year/:month → congés qui chevauchent le mois donné
 *
 * Query params optionnels :
 *  - entrepriseId : UUID  (super_admin seulement)
 *  - statut       : ex. 'valide_final'
 *  - utilisateurId: UUID
 */
async function getCalendrier(req, res) {
  try {
    const { year, month } = req.params;
    const { entrepriseId, statut, utilisateurId } = req.query;

    // ─── filtrage par entreprise ─────────────────────────────────────────────
    let targetEntrepriseId;
    if (req.user.role === 'super_admin') {
      targetEntrepriseId = entrepriseId || null; // null = toutes les entreprises si SA sans filtre
    } else {
      targetEntrepriseId = req.user.entreprise_id;
    }

    // ─── construction du where ───────────────────────────────────────────────
    const where = {};

    if (targetEntrepriseId) {
      where.entreprise_id = targetEntrepriseId;
    }

    if (statut && statut !== 'all') {
      where.statut = statut;
    }

    if (utilisateurId && utilisateurId !== 'all') {
      where.utilisateur_id = utilisateurId;
    }

    // filtre sur le mois si year/month sont fournis
    if (year && month) {
      const firstDay = dayjs(`${year}-${String(month).padStart(2, '0')}-01`).startOf('month').toDate();
      const lastDay  = dayjs(`${year}-${String(month).padStart(2, '0')}-01`).endOf('month').toDate();
      where.date_debut = { [Op.lte]: lastDay };
      where.date_fin   = { [Op.gte]: firstDay };
    }

    const conges = await Conge.findAll({
      where,
      include: [
        {
          model: CongeType,
          as: 'conge_type',
          attributes: ['id', 'code', 'libelle'],
        },
        {
          model: Utilisateur,
          as: 'utilisateur',
          attributes: ['id', 'nom', 'prenom', 'service', 'email'],
        },
      ],
      order: [['date_debut', 'ASC']],
    });

    res.json(conges);
  } catch (err) {
    logger.error(err);
    res.status(500).json({ message: err.message });
  }
}

module.exports = { getCalendrier };
