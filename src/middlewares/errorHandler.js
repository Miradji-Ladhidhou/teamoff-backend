function errorHandler(err, req, res, next) {
  console.error(err);

  if (err.message.includes('introuvable')) return res.status(404).json({ message: err.message });
  if (err.message.includes('Chevauchement')) return res.status(400).json({ message: err.message });
  if (err.message.includes('Solde insuffisant')) return res.status(403).json({ message: err.message });
  if (err.message.includes('Accès interdit')) return res.status(403).json({ message: err.message });

  res.status(500).json({ message: 'Erreur serveur', error: err.message });
}

module.exports = errorHandler;