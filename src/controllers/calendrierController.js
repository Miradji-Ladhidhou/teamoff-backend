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
async function getCalendrier(req, res, next) {
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

    const canFilterByUser = ['super_admin', 'admin_entreprise', 'manager'].includes(req.user.role);
    if (req.user.role === 'employe') {
      where.utilisateur_id = req.user.id;
    } else if (canFilterByUser && utilisateurId && utilisateurId !== 'all') {
      where.utilisateur_id = utilisateurId;
    }

    // filtre sur le mois si year/month sont fournis
    if (year || month) {
      const y = Number(year);
      const m = Number(month);
      if (!Number.isInteger(y) || y < 2000 || y > 2100) {
        return res.status(400).json({ message: 'Paramètre year invalide (attendu : entier entre 2000 et 2100)' });
      }
      if (!Number.isInteger(m) || m < 1 || m > 12) {
        return res.status(400).json({ message: 'Paramètre month invalide (attendu : entier entre 1 et 12)' });
      }
      const firstDay = dayjs(`${y}-${String(m).padStart(2, '0')}-01`).startOf('month').toDate();
      const lastDay  = dayjs(`${y}-${String(m).padStart(2, '0')}-01`).endOf('month').toDate();
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
    next(err);
  }
}

module.exports = { getCalendrier };
