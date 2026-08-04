const { Op } = require('sequelize');
const logger = require('../utils/logger');
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
      logger.error('Erreur lors de l\'envoi de l\'alerte:', error);
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

  // Rétention minimale obligatoire pour les audit logs (politique de sécurité)
  static MIN_RETENTION_DAYS = 90;

  // Nettoyer les anciennes métriques
  // callerUser : { id, role } de l'utilisateur qui lance le cleanup (pour audit trail)
  static async cleanupOldMetrics(daysToKeep = 90, callerUser = null) {
    const retentionDays = Number(daysToKeep);
    if (!Number.isFinite(retentionDays) || retentionDays < MonitoringService.MIN_RETENTION_DAYS) {
      throw Object.assign(
        new Error(`daysToKeep doit être ≥ ${MonitoringService.MIN_RETENTION_DAYS} jours`),
        { code: 'RETENTION_TOO_SHORT' }
      );
    }

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - retentionDays);

    // Les logs AUDIT_CLEANUP ne sont jamais purgés : ils constituent la traçabilité
    // des purges elles-mêmes et doivent survivre à toute rétention.
    const [deletedAuditLogs, deletedNotifications] = await Promise.all([
      AuditLog.destroy({
        where: {
          created_at: { [Op.lt]: cutoffDate },
          action: { [Op.ne]: 'AUDIT_CLEANUP' },
        }
      }),
      Notification.destroy({
        where: {
          created_at: { [Op.lt]: cutoffDate }
        }
      })
    ]);

    // Journaliser l'action de cleanup (qui, quand, combien)
    await AuditLog.create({
      action: 'AUDIT_CLEANUP',
      entity: 'system',
      user_id: callerUser?.id ?? null,
      metadata: {
        daysToKeep: retentionDays,
        cutoffDate: cutoffDate.toISOString(),
        deletedAuditLogs,
        deletedNotifications,
      },
    }).catch(err => logger.error('Impossible de journaliser le cleanup:', err));

    return {
      cutoffDate: cutoffDate.toISOString(),
      deletedAuditLogs,
      deletedNotifications,
      retentionDays,
    };
  }
}

module.exports = MonitoringService;