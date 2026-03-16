const UsageService = require('../services/usageService');

// Middleware pour vérifier les limites d'usage
const checkUsageLimit = (action) => {
  return async (req, res, next) => {
    try {
      const entrepriseId = req.user?.entreprise_id || req.body?.entreprise_id;

      if (!entrepriseId) {
        return res.status(400).json({
          error: 'Entreprise ID manquant'
        });
      }

      const limitCheck = await UsageService.checkUsageLimit(entrepriseId, action);

      if (!limitCheck.allowed) {
        return res.status(429).json({
          error: 'Limite d\'usage dépassée',
          message: `Vous avez atteint la limite de votre plan pour cette fonctionnalité.`,
          remaining: limitCheck.remaining
        });
      }

      // Ajouter les informations d'usage à la requête
      req.usageInfo = limitCheck;
      next();
    } catch (error) {
      console.error('Erreur lors de la vérification des limites d\'usage:', error);
      next(); // En cas d'erreur, continuer sans bloquer
    }
  };
};

module.exports = { checkUsageLimit };