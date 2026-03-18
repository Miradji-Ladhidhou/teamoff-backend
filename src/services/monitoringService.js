const { Op } = require('sequelize');
const { Notification, Utilisateur, sequelize, AuditLog } = require('../models');
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

        // Créer une notification par administrateur
        await Notification.create({
          utilisateur_id: admin.id,
          entreprise_id: entrepriseId,
          type: 'system_alert',
          message: alert.message,
          url: '/admin/monitoring',
          lu: false
        });
      }

    } catch (error) {
      console.error('Erreur lors de l\'envoi de l\'alerte:', error);
    }
  }

  // Obtenir les admins d'une entreprise
  static async getEntrepriseAdmins(entrepriseId) {
    return await Utilisateur.findAll({
      where: {
        entreprise_id: entrepriseId,
        role: { [Op.in]: ['admin_entreprise', 'super_admin'] }
      }
    });
  }

  // Rapport de santé du système
  static async getHealthReport() {
    const report = {
      database: { status: 'unhealthy' },
      email: { status: 'unhealthy' },
      cache: { status: 'unknown', reason: 'Cache non configuré' },
      timestamp: new Date().toISOString()
    };

    try {
      await sequelize.authenticate();
      report.database = { status: 'healthy' };
    } catch (error) {
      report.database = { status: 'unhealthy', error: error.message };
    }

    try {
      const smtpConfig = await emailService.getSmtpConfig();
      const transporter = emailService.createTransporter(smtpConfig);
      await transporter.verify();
      report.email = { status: 'healthy' };
    } catch (error) {
      report.email = { status: 'unhealthy', error: error.message };
    }

    report.status = [report.database.status, report.email.status].every((status) => status === 'healthy')
      ? 'healthy'
      : 'degraded';

    return {
      ...report,
    };
  }

  // Nettoyer les anciennes métriques
  static async cleanupOldMetrics(daysToKeep = 30) {
    const retentionDays = Number(daysToKeep);
    const safeRetentionDays = Number.isFinite(retentionDays) && retentionDays > 0 ? retentionDays : 30;
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - safeRetentionDays);

    const [deletedAuditLogs, deletedNotifications] = await Promise.all([
      AuditLog.destroy({
        where: {
          createdAt: { [Op.lt]: cutoffDate }
        }
      }),
      Notification.destroy({
        where: {
          created_at: { [Op.lt]: cutoffDate }
        }
      })
    ]);

    return {
      cutoffDate: cutoffDate.toISOString(),
      deletedAuditLogs,
      deletedNotifications,
      retentionDays: safeRetentionDays,
    };
  }
}

module.exports = MonitoringService;