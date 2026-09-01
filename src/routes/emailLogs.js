const express = require('express');
const router = express.Router();
const { Op, literal } = require('sequelize');
const { EmailLog, Utilisateur, Entreprise } = require('../models');
const authorizeRole = require('../middlewares/authorizeRole');

router.get('/', authorizeRole(['super_admin']), async (req, res, next) => {
  try {
    const {
      page = 1, limit = 25,
      statut, type, entreprise_id, to_address, search,
      dateDebut, dateFin,
      sortBy = 'date', sortOrder = 'DESC',
    } = req.query;

    const pageNum = Math.max(1, parseInt(page, 10));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10)));
    const offset = (pageNum - 1) * limitNum;

    const where = {};
    if (statut) where.statut = statut;
    if (type) where.type = type;
    if (entreprise_id) where.entreprise_id = entreprise_id;
    if (to_address) where.to_address = { [Op.iLike]: `%${to_address}%` };

    if (dateDebut || dateFin) {
      where.created_at = {};
      if (dateDebut) where.created_at[Op.gte] = new Date(dateDebut);
      if (dateFin) { const f = new Date(dateFin); f.setHours(23, 59, 59, 999); where.created_at[Op.lte] = f; }
    }

    if (search) {
      const s = String(search).slice(0, 100);
      where[Op.or] = [
        { to_address:    { [Op.iLike]: `%${s}%` } },
        { subject:       { [Op.iLike]: `%${s}%` } },
        { type:          { [Op.iLike]: `%${s}%` } },
        { error_message: { [Op.iLike]: `%${s}%` } },
      ];
    }

    const dir = sortOrder.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
    const SORT_MAP = {
      date:       [['created_at', dir]],
      type:       [['type', dir], ['created_at', 'DESC']],
      statut:     [['statut', dir], ['created_at', 'DESC']],
      to:         [['to_address', dir], ['created_at', 'DESC']],
      // literal évite les ambiguïtés Sequelize 6 avec subQuery:false + association order
      entreprise: [literal(`"entreprise"."nom" ${dir} NULLS LAST`), ['created_at', 'DESC']],
    };
    const order = SORT_MAP[sortBy] || SORT_MAP.date;

    const { rows: logs, count: total } = await EmailLog.findAndCountAll({
      where,
      include: [
        { model: Entreprise,  as: 'entreprise',  attributes: ['id', 'nom'], required: false },
        { model: Utilisateur, as: 'utilisateur', attributes: ['id', 'prenom', 'nom', 'email'], required: false },
      ],
      order,
      limit: limitNum,
      offset,
      distinct: true,
      subQuery: false,
    });

    res.json({ logs, total, page: pageNum, totalPages: Math.ceil(total / limitNum), limit: limitNum });
  } catch (err) { next(err); }
});

module.exports = router;
