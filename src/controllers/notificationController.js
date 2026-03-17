// /controllers/notificationController.js
const { Notification } = require('../models');

/**
 * Récupérer les notifications de l'utilisateur connecté
 */
async function getNotifications(req, res) {
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

    res.json({
      items: rows,
      pagination: {
        page,
        limit,
        total: count,
        totalPages: Math.max(1, Math.ceil(count / limit)),
      },
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

/**
 * Marquer une notification comme lue
 */
async function marquerCommeLue(req, res) {
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
    res.status(400).json({ message: err.message });
  }
}

/**
 * Marquer toutes les notifications comme lues
 */
async function toutMarquerCommeLue(req, res) {
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
    res.status(500).json({ message: err.message });
  }
}

module.exports = {
  getNotifications,
  marquerCommeLue,
  toutMarquerCommeLue
};