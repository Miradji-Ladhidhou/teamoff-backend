module.exports = (allowedRoles = [], getTargetEntrepriseId = null) => {
  return (req, res, next) => {
    const user = req.user;

    if (!user) return res.status(401).json({ message: 'Utilisateur non authentifié' });

    // ---------------------------
    // 1️ Super admin bypass total
    // ---------------------------
    if (user.role === 'super_admin') return next();

    // ---------------------------
    // 2️ Vérification du rôle hiérarchique
    // ---------------------------
    const hierarchy = ['employe', 'manager', 'admin_entreprise', 'super_admin'];
    const userLevel = hierarchy.indexOf(user.role);

    const allowedLevels = allowedRoles.map(r => hierarchy.indexOf(r));

    // L'utilisateur doit avoir un niveau >= minimum des rôles autorisés
    if (!allowedLevels.some(level => userLevel >= level)) {
      return res.status(403).json({ message: 'Accès interdit : rôle insuffisant' });
    }

    // ---------------------------
    // 3️ Vérification multi-tenant si une fonction cible est fournie
    // ---------------------------
    if (getTargetEntrepriseId) {
      const targetId = getTargetEntrepriseId(req);
      if (!targetId) return res.status(400).json({ message: 'Entreprise cible introuvable' });

      if (user.entreprise_id !== targetId) {
        return res.status(403).json({ message: 'Accès interdit : entreprise différente' });
      }
    }

    next();
  };
};
