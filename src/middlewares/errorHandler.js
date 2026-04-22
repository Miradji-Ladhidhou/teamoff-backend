const logger = require('../utils/logger');

function errorHandler(err, req, res, next) {
  logger.error(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`);
  if (req.user) logger.error(`Utilisateur: ${req.user.id} | Role: ${req.user.role}`);
  logger.error(err);

  // JSON syntax error from express.json()
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({ message: 'JSON invalide' });
  }

  const message = err.message || 'Erreur serveur';

  if (message.includes('introuvable')) return res.status(404).json({ message });
  if (message.includes('Chevauchement')) return res.status(400).json({ message });
  if (message.includes('Solde insuffisant')) return res.status(403).json({ message });
  if (message.includes('Accès interdit')) return res.status(403).json({ message });

  res.status(500).json({ message: 'Erreur serveur', error: message });
}

module.exports = errorHandler;