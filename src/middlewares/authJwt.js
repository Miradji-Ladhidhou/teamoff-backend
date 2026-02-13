const jwt = require('jsonwebtoken');
require('dotenv').config();
const { Utilisateur } = require('../models');

module.exports = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Token manquant' });
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Récupérer l'utilisateur pour vérifier le statut
    const user = await Utilisateur.findByPk(decoded.id);
    if (!user) return res.status(401).json({ message: 'Utilisateur non trouvé' });

    // Gestion du statut
    if (user.statut === 'en_attente') {
      return res.status(403).json({ message: 'Votre compte est en attente de validation.' });
    } 
    if (user.statut === 'inactif') {
      return res.status(403).json({ message: 'Votre compte est désactivé.' });
    }

    // Attacher l'utilisateur à la requête
    req.user = {
      id: user.id,
      role: user.role,
      entreprise_id: user.entreprise_id,
      statut: user.statut,
    };

    next();
  } catch (err) {
    return res.status(401).json({ message: 'Token invalide ou expiré' });
  }
};
