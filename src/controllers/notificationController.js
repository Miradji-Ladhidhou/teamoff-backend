// /controllers/notificationController.js
const { Notification, Entreprise } = require('../models');
const logger = require('../utils/logger');
const { resolveTimezone, formatDateInTimezone, toIsoString } = require('../utils/dateFormatter');

/**
 * Récupérer les notifications de l'utilisateur connecté
 */
async function getNotifications(req, res, next) {
  try {
    const where = { utilisateur_id: req.user.id };
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const offset = (page - 1) * limit;

    if (req.query.non_lu === 'true') {
      where.lu = false;
    }

    const { rows, count } = await Notification.findAndCountAll({
      where,
      limit,
      offset,
      order: [['created_at', 'DESC']]
    });

    const entreprise = await Entreprise.findByPk(req.user.entreprise_id, {
      attributes: ['nom', 'parametres'],
    });
    const timezone = resolveTimezone(entreprise?.parametres, req.query.timezone);

    const items = rows.map((row) => {
      const raw = row.get({ plain: true });
      const createdAtSource = raw.created_at || raw.createdAt;

      return {
        ...raw,
        entreprise_nom: entreprise?.nom || null,
        created_at_iso: toIsoString(createdAtSource),
        created_at_display: formatDateInTimezone(createdAtSource, timezone),
        timezone,
      };
    });

    res.json({
      items,
      pagination: {
        page,
        limit,
        total: count,
        totalPages: Math.max(1, Math.ceil(count / limit)),
      },
    });
  } catch (err) {
    logger.error('getNotifications error', { user_id: req.user?.id, error: err.message });
    next(err);
  }
}

/**
 * Marquer une notification comme lue
 */
async function marquerCommeLue(req, res, next) {
  try {
    const notif = await Notification.findOne({
      where: {
        id: req.params.id,
        utilisateur_id: req.user.id
      }
    });

    if (!notif) {
      return res.status(404).json({ message: 'Notification introuvable' });
    }

    notif.lu = true;
    await notif.save();

    res.json({ message: 'Notification marquée comme lue', notif });

  } catch (err) {
    logger.error('marquerCommeLue error', { user_id: req.user?.id, notif_id: req.params.id, error: err.message });
    next(err);
  }
}

/**
 * Marquer toutes les notifications comme lues
 */
async function toutMarquerCommeLue(req, res, next) {
  try {
    await Notification.update(
      { lu: true },
      {
        where: {
          utilisateur_id: req.user.id,
          lu: false
        }
      }
    );

    res.json({ message: 'Toutes les notifications sont marquées comme lues' });

  } catch (err) {
    logger.error('toutMarquerCommeLue error', { user_id: req.user?.id, error: err.message });
    next(err);
  }
}

module.exports = {
  getNotifications,
  marquerCommeLue,
  toutMarquerCommeLue
};