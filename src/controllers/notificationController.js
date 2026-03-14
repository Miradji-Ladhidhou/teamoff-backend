// /controllers/notificationController.js
const { Notification } = require('../models');

/**
 * Récupérer les notifications de l'utilisateur connecté
 */
async function getNotifications(req, res) {
  try {
    const where = { utilisateur_id: req.user.id };

    if (req.query.non_lu === 'true') {
      where.lu = false;
    }

    const notifications = await Notification.findAll({
      where,
      order: [['created_at', 'DESC']]
    });

    res.json(notifications);
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