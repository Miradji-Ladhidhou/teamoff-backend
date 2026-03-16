const { Notification } = require('../models');
const emailService = require('./emailService');

class MonitoringService {
  // Seuils d'alerte
  static ALERT_THRESHOLDS = {
    highErrorRate: 0.1, // 10% d'erreurs
    highResponseTime: 5000, // 5 secondes
    lowUsageQuota: 0.8, // 80% d'utilisation des quotas
    inactiveUsers: 30 // jours d'inactivité
  };

  // Vérifier les métriques et envoyer des alertes si nécessaire
  static async checkMetricsAndAlert(metrics) {
    const alerts = [];

    // Vérifier le taux d'erreur
    if (metrics.errorRate > this.ALERT_THRESHOLDS.highErrorRate) {
      alerts.push({
        type: 'high_error_rate',
        message: `Taux d'erreur élevé: ${(metrics.errorRate * 100).toFixed(2)}%`,
        severity: 'high'
      });
    }

    // Vérifier le temps de réponse moyen
    if (metrics.avgResponseTime > this.ALERT_THRESHOLDS.highResponseTime) {
      alerts.push({
        type: 'high_response_time',
        message: `Temps de réponse élevé: ${metrics.avgResponseTime}ms`,
        severity: 'medium'
      });
    }

    // Vérifier l'utilisation des quotas
    if (metrics.quotaUsage > this.ALERT_THRESHOLDS.lowUsageQuota) {
      alerts.push({
        type: 'low_quota',
        message: `Quota d'utilisation élevé: ${(metrics.quotaUsage * 100).toFixed(2)}%`,
        severity: 'low'
      });
    }

    // Envoyer les alertes
    for (const alert of alerts) {
      await this.sendAlert(alert, metrics.entrepriseId);
    }

    return alerts;
  }

  // Envoyer une alerte par email
  static async sendAlert(alert, entrepriseId) {
    try {
      // Trouver les admins de l'entreprise
      const admins = await this.getEntrepriseAdmins(entrepriseId);

      for (const admin of admins) {
        await emailService.sendAlertEmail(admin.email, alert);
      }

      // Créer une notification en base
      await Notification.create({
        utilisateur_id: null, // Notification système
        entreprise_id: entrepriseId,
        type: 'system_alert',
        titre: 'Alerte système',
        message: alert.message,
        severity: alert.severity,
        is_read: false
      });

    } catch (error) {
      console.error('Erreur lors de l\'envoi de l\'alerte:', error);
    }
  }

  // Obtenir les admins d'une entreprise
  static async getEntrepriseAdmins(entrepriseId) {
    const { Utilisateur } = require('../models');
    return await Utilisateur.findAll({
      where: {
        entreprise_id: entrepriseId,
        role: ['admin_entreprise', 'super_admin']
      }
    });
  }

  // Rapport de santé du système
  static async getHealthReport() {
    // TODO: Implémenter la vérification de la santé des services
    return {
      database: 'healthy',
      email: 'healthy',
      cache: 'healthy',
      timestamp: new Date()
    };
  }

  // Nettoyer les anciennes métriques
  static async cleanupOldMetrics(daysToKeep = 30) {
    // TODO: Implémenter le nettoyage des métriques anciennes
    console.log(`Nettoyage des métriques de plus de ${daysToKeep} jours`);
  }
}

module.exports = MonitoringService;