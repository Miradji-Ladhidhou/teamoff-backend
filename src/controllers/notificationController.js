// /controllers/notificationController.js
const { Notification, Entreprise } = require('../models');

const DEFAULT_TIMEZONE = process.env.DEFAULT_APP_TIMEZONE || 'Europe/Paris';

function isValidTimezone(timezone) {
  if (typeof timezone !== 'string' || !timezone.trim()) {
    return false;
  }

  try {
    new Intl.DateTimeFormat('fr-FR', { timeZone: timezone.trim() });
    return true;
  } catch (error) {
    return false;
  }
}

function normalizeTimezone(timezone) {
  if (!isValidTimezone(timezone)) {
    return null;
  }

  return timezone.trim();
}

function getEntrepriseTimezone(parametres, preferredTimezone) {
  const preferred = normalizeTimezone(preferredTimezone);
  if (preferred) {
    return preferred;
  }

  const tz = parametres?.timezone;
  const entrepriseTimezone = normalizeTimezone(tz);
  if (entrepriseTimezone) {
    return entrepriseTimezone;
  }

  return normalizeTimezone(DEFAULT_TIMEZONE) || 'UTC';
}

function formatDateInTimezone(dateValue, timezone) {
  if (!dateValue) {
    return null;
  }

  const date = new Date(dateValue);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return new Intl.DateTimeFormat('fr-FR', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date);
}

function toIsoString(dateValue) {
  if (!dateValue) {
    return null;
  }

  const date = new Date(dateValue);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toISOString();
}

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

    const entreprise = await Entreprise.findByPk(req.user.entreprise_id, {
      attributes: ['nom', 'parametres'],
    });
    const timezone = getEntrepriseTimezone(entreprise?.parametres, req.query.timezone);

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