module.exports = (allowedRoles = [], getTargetEntrepriseId = null) => {
  return (req, res, next) => {
    const user = req.user;
    if (!user) return res.status(401).json({ message: 'Utilisateur non authentifié' });

    // Super admin bypass total
    if (user.role === 'super_admin') return next();

    const allowed = allowedRoles.includes(user.role);
    if (!allowed) return res.status(403).json({ message: 'Accès interdit : rôle insuffisant' });

    // Vérification multi-tenant si fonction cible
    if (getTargetEntrepriseId) {
      const targetId = getTargetEntrepriseId(req);
      if (targetId && user.entreprise_id !== targetId) {
        return res.status(403).json({ message: 'Accès interdit : entreprise différente' });
      }
    }

    next();
  };
};