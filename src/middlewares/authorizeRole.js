const logger = require('../utils/logger');

module.exports = (allowedRoles = [], getTargetEntrepriseId = null) => {
  return (req, res, next) => {
    const user = req.user;
    if (!user) return res.status(401).json({ message: 'Utilisateur non authentifié' });

    // Super admin bypass total
    if (user.role === 'super_admin') return next();

    if (!allowedRoles.includes(user.role)) {
      logger.warn('Accès refusé : rôle insuffisant', {
        user_id: user.id,
        role: user.role,
        required_roles: allowedRoles,
        method: req.method,
        url: req.originalUrl,
      });
      return res.status(403).json({ message: 'Accès interdit : rôle insuffisant' });
    }

    // Vérification multi-tenant si fonction cible
    if (getTargetEntrepriseId) {
      const targetId = getTargetEntrepriseId(req);
      if (targetId && user.entreprise_id !== targetId) {
        logger.warn('Accès refusé : entreprise différente', {
          user_id: user.id,
          user_entreprise: user.entreprise_id,
          target_entreprise: targetId,
          method: req.method,
          url: req.originalUrl,
        });
        return res.status(403).json({ message: 'Accès interdit : entreprise différente' });
      }
    }

    next();
  };
};
