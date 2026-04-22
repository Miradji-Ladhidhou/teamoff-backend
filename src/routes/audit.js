const express = require('express');
const logger = require('../utils/logger');
const router = express.Router();
const { Op } = require('sequelize');
const { AuditLog, Utilisateur, Entreprise } = require('../models');
const authorizeRole = require('../middlewares/authorizeRole');

/**
 * GET /api/audit
 * Liste paginée des logs d'audit — super_admin uniquement
 * Paramètres query : page, limit, action, entity, dateDebut, dateFin, search
 */
router.get('/', authorizeRole(['super_admin']), async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      action,
      entity,
      dateDebut,
      dateFin,
      search,
    } = req.query;

    const pageNum = Math.max(1, parseInt(page, 10));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10)));
    const offset = (pageNum - 1) * limitNum;

    const where = {};

    if (action) where.action = action;
    if (entity) where.entity = entity;

    if (dateDebut || dateFin) {
      where.createdAt = {};
      if (dateDebut) where.createdAt[Op.gte] = new Date(dateDebut);
      if (dateFin) {
        const fin = new Date(dateFin);
        fin.setHours(23, 59, 59, 999);
        where.createdAt[Op.lte] = fin;
      }
    }

    const includeUser = {
      model: Utilisateur,
      as: 'utilisateur',
      attributes: ['id', 'prenom', 'nom', 'email'],
      required: false,
    };

    // Filtre texte : cherche dans action, entity ou email/nom de l'utilisateur
    if (search) {
      where[Op.or] = [
        { action: { [Op.iLike]: `%${search}%` } },
        { entity: { [Op.iLike]: `%${search}%` } },
        { ip_address: { [Op.iLike]: `%${search}%` } },
        { '$utilisateur.prenom$': { [Op.iLike]: `%${search}%` } },
        { '$utilisateur.nom$': { [Op.iLike]: `%${search}%` } },
        { '$utilisateur.email$': { [Op.iLike]: `%${search}%` } },
      ];
    }

    const { rows: logs, count: total } = await AuditLog.findAndCountAll({
      where,
      include: [
        includeUser,
        {
          model: Entreprise,
          as: 'entreprise',
          attributes: ['id', 'nom'],
          required: false,
        },
      ],
      order: [['createdAt', 'DESC']],
      limit: limitNum,
      offset,
      distinct: true,
    });

    res.json({
      logs,
      total,
      page: pageNum,
      totalPages: Math.ceil(total / limitNum),
      limit: limitNum,
    });
  } catch (error) {
    logger.error('Erreur récupération logs audit:', error);
    res.status(500).json({ message: 'Erreur serveur lors de la récupération des logs d\'audit' });
  }
});

module.exports = router;
