const { Op } = require('sequelize');
const { Conge, Utilisateur, JoursFeries } = require('../models');
const { PLAN_LIMITS, checkLimits } = require('../config/limits');

class UsageService {
  // Compter les congés créés ce mois pour une entreprise
  static async countCongesThisMonth(entrepriseId) {
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const endOfMonth = new Date();
    endOfMonth.setMonth(endOfMonth.getMonth() + 1, 0);
    endOfMonth.setHours(23, 59, 59, 999);

    const count = await Conge.count({
      where: {
        entreprise_id: entrepriseId,
        created_at: {
          [Op.between]: [startOfMonth, endOfMonth]
        }
      }
    });

    return count;
  }

  // Compter les utilisateurs actifs pour une entreprise
  static async countActiveUsers(entrepriseId) {
    const count = await Utilisateur.count({
      where: {
        entreprise_id: entrepriseId,
        statut: 'actif'
      }
    });

    return count;
  }

  // Compter les jours fériés pour une entreprise
  static async countJoursFeries(entrepriseId) {
    const count = await JoursFeries.count({
      where: {
        entreprise_id: entrepriseId
      }
    });

    return count;
  }

  // Vérifier si une action est autorisée selon les limites du plan
  static async checkUsageLimit(entrepriseId, action) {
    return await checkLimits(entrepriseId, action);
  }

  // Obtenir un rapport d'usage pour une entreprise
  static async getUsageReport(entrepriseId) {
    const [congesCount, usersCount, joursFeriesCount] = await Promise.all([
      this.countCongesThisMonth(entrepriseId),
      this.countActiveUsers(entrepriseId),
      this.countJoursFeries(entrepriseId)
    ]);

    return {
      congesThisMonth: congesCount,
      activeUsers: usersCount,
      joursFeries: joursFeriesCount,
      limits: PLAN_LIMITS.free // TODO: Récupérer le plan réel de l'entreprise
    };
  }
}

module.exports = UsageService;