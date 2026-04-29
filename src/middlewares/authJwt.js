const jwt = require('jsonwebtoken');
require('dotenv').config();
const { Utilisateur, Entreprise } = require('../models');
const logger = require('../utils/logger');

module.exports = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Token manquant' });
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Bloquer l'usage d'un token de reset-password comme token d'auth
    if (decoded.type === 'reset') {
      return res.status(401).json({ message: 'Token invalide pour cette opération' });
    }

    // Récupérer l'utilisateur pour vérifier le statut
    const user = await Utilisateur.findByPk(decoded.id);
    if (!user) return res.status(401).json({ message: 'Utilisateur non trouvé' });

    // Gestion du statut de l'utilisateur
    if (user.statut === 'en_attente') {
      return res.status(403).json({
        error: 'COMPTE_EN_ATTENTE',
        message: 'Votre compte est en attente de validation.',
        user_statut: user.statut
      });
    }
    if (user.statut === 'inactif') {
      return res.status(403).json({
        error: 'COMPTE_INACTIF',
        message: 'Votre compte est désactivé.',
        user_statut: user.statut
      });
    }

    // Gestion du statut de l'entreprise
    const entreprise = await Entreprise.findByPk(user.entreprise_id);

    if (!entreprise) {
      return res.status(403).json({ message: 'Entreprise introuvable' });
    }

    if (entreprise.statut === 'inactive') {
      return res.status(402).json({
        error: 'ENTREPRISE_INACTIVE',
        message: 'Votre abonnement est inactif.',
        entreprise_statut: entreprise.statut
      });
    }

    if (entreprise.statut === 'suspendue') {
      return res.status(403).json({
        error: 'ENTREPRISE_SUSPENDUE',
        message: 'Votre compte entreprise est suspendu.',
        entreprise_statut: entreprise.statut
      });
    }

    // Attacher l'utilisateur à la requête
    req.user = {
      id: user.id,
      role: user.role,
      entreprise_id: user.entreprise_id,
      statut: user.statut
    };

    next();
  } catch (err) {
    if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError' || err.name === 'NotBeforeError') {
      return res.status(401).json({ message: 'Token invalide ou expiré' });
    }
    logger.error('authJwt error', { error: err.message });
    return res.status(500).json({ message: 'Erreur serveur lors de l\'authentification' });
  }
};
