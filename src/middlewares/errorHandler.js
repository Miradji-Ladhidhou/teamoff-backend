const logger = require('../utils/logger');
const sanitizeLogData = require('../utils/sanitizeLogData');

function errorHandler(err, req, res, next) {
  logger.error('unhandled_error', sanitizeLogData({
    requestId: req.id ?? null,
    method:    req.method,
    path:      req.originalUrl,
    userId:    req.user?.id ?? null,
    role:      req.user?.role ?? null,
    errName:   err.name,
    errMsg:    err.message,
    stack:     process.env.NODE_ENV !== 'production' ? err.stack : undefined,
  }));

  // JSON malformé
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({ message: 'JSON invalide' });
  }

  // Erreurs métier explicites (status ou statusCode posé par nos services/controllers)
  const httpStatus = err.statusCode ?? err.status;
  if (Number.isInteger(httpStatus) && httpStatus >= 400 && httpStatus < 600) {
    return res.status(httpStatus).json({ message: err.message });
  }

  // ── Erreurs Sequelize ──────────────────────────────────────────────────────
  // Aucun message interne n'est exposé au client.

  if (err.name === 'SequelizeUniqueConstraintError') {
    return res.status(409).json({ message: 'Cette valeur existe déjà' });
  }

  if (err.name === 'SequelizeValidationError') {
    return res.status(400).json({ message: 'Données invalides' });
  }

  if (err.name === 'SequelizeForeignKeyConstraintError') {
    return res.status(400).json({ message: 'Référence invalide' });
  }

  if (err.name?.startsWith('Sequelize')) {
    return res.status(500).json({ message: 'Erreur base de données' });
  }

  res.status(500).json({ message: 'Erreur serveur' });
}

module.exports = errorHandler;
