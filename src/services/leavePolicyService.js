/**
 * Service de gestion des politiques de congés par entreprise
 * Centralise la validation des règles métier
 */

const { LeavePolicy, Entreprise } = require('../models');

class LeavePolicyService {
  /**
   * Récupérer ou créer une politique par défaut pour une entreprise
   */
  static async getOrCreateDefaultPolicy(entrepriseId) {
    let policy = await LeavePolicy.findOne({
      where: { entreprise_id: entrepriseId },
    });

    if (!policy) {
      // Créer une politique par défaut
      policy = await LeavePolicy.create({
        entreprise_id: entrepriseId,
        allow_modify_validated: false,
        allow_cancel_validated: false,
        min_notice_days: 2,
        max_backdate_days: 0,
        require_manager_approval: true,
        require_admin_approval: false,
      });
    }

    return policy;
  }

  /**
   * Récupérer la politique d'une entreprise
   */
  static async getPolicyForEntreprise(entrepriseId) {
    return LeavePolicy.findOne({
      where: { entreprise_id: entrepriseId },
    });
  }

  /**
   * Valider si la modification d'un congé est autorisée selon la politique
   *
   * @param {Object} params
   * @param {string} params.entrepriseId - ID de l'entreprise
   * @param {string} params.congeStatus - Statut du congé (en_attente_manager, valide_manager, etc.)
   * @param {Date} params.congeStartDate - Date de début du congé
   * @param {Date} params.initiatorRole - Rôle de la personne qui modifie (employe, manager, admin_entreprise, super_admin)
   * @returns {Promise<{allowed: boolean, reason?: string}>}
   */
  static async validateModification(params) {
    const {
      entrepriseId,
      congeStatus,
      congeStartDate,
      initiatorRole,
    } = params;

    const policy = await this.getOrCreateDefaultPolicy(entrepriseId);

    // Les super admins ne sont jamais bloqués
    if (initiatorRole === 'super_admin') {
      return { allowed: true };
    }

    // Vérifier si le congé est validé (au management ou final)
    const isValidated = congeStatus && (
      congeStatus.includes('valide_manager') ||
      congeStatus.includes('valide_final')
    );

    if (isValidated && !policy.allow_modify_validated) {
      return {
        allowed: false,
        reason: 'Modification non autorisée pour un congé validé selon la politique de l\'entreprise',
        code: 'POLICY_MODIFY_VALIDATED_DISABLED',
      };
    }

    // Vérifier le préavis minimum
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const startDate = new Date(congeStartDate);
    startDate.setHours(0, 0, 0, 0);

    const daysUntilStart = Math.floor((startDate - today) / (1000 * 60 * 60 * 24));

    if (daysUntilStart < policy.min_notice_days) {
      return {
        allowed: false,
        reason: `Préavis minimum non respecté. Minimum requis: ${policy.min_notice_days} jour(s), disponible: ${daysUntilStart} jour(s)`,
        code: 'POLICY_NOTICE_PERIOD_INSUFFICIENT',
        daysRequired: policy.min_notice_days,
        daysAvailable: daysUntilStart,
      };
    }

    // Vérifier la modification rétroactive
    const daysSinceStart = Math.floor((today - startDate) / (1000 * 60 * 60 * 24));

    if (daysSinceStart > 0 && daysSinceStart > policy.max_backdate_days) {
      return {
        allowed: false,
        reason: `Modification rétroactive non autorisée. Le congé a déjà commencé il y a ${daysSinceStart} jour(s), maximum autorisé: ${policy.max_backdate_days} jour(s)`,
        code: 'POLICY_BACKDATE_EXCEEDED',
        daysSinceStart,
        maxBackdateDays: policy.max_backdate_days,
      };
    }

    return { allowed: true };
  }

  /**
   * Valider si l'annulation d'un congé est autorisée selon la politique
   *
   * @param {Object} params
   * @param {string} params.entrepriseId - ID de l'entreprise
   * @param {string} params.congeStatus - Statut du congé
   * @param {Date} params.congeStartDate - Date de début du congé
   * @param {string} params.initiatorRole - Rôle de la personne qui annule
   * @returns {Promise<{allowed: boolean, reason?: string}>}
   */
  static async validateCancellation(params) {
    const {
      entrepriseId,
      congeStatus,
      congeStartDate,
      initiatorRole,
    } = params;

    const policy = await this.getOrCreateDefaultPolicy(entrepriseId);

    // Les super admins ne sont jamais bloqués
    if (initiatorRole === 'super_admin') {
      return { allowed: true };
    }

    // Vérifier si le congé est validé
    const isValidated = congeStatus && (
      congeStatus.includes('valide_manager') ||
      congeStatus.includes('valide_final')
    );

    if (isValidated && !policy.allow_cancel_validated) {
      return {
        allowed: false,
        reason: 'Annulation non autorisée pour un congé validé selon la politique de l\'entreprise',
        code: 'POLICY_CANCEL_VALIDATED_DISABLED',
      };
    }

    // Vérifier le préavis minimum pour annulation
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const startDate = new Date(congeStartDate);
    startDate.setHours(0, 0, 0, 0);

    const daysUntilStart = Math.floor((startDate - today) / (1000 * 60 * 60 * 24));

    if (daysUntilStart < policy.min_notice_days) {
      return {
        allowed: false,
        reason: `Préavis minimum non respecté pour l'annulation. Minimum requis: ${policy.min_notice_days} jour(s), disponible: ${daysUntilStart} jour(s)`,
        code: 'POLICY_NOTICE_PERIOD_INSUFFICIENT',
        daysRequired: policy.min_notice_days,
        daysAvailable: daysUntilStart,
      };
    }

    return { allowed: true };
  }

  /**
   * Déterminer le workflow d'approbation selon la politique
   *
   * @param {string} entrepriseId
   * @returns {Promise<{needsManager: boolean, needsAdmin: boolean}>}
   */
  static async getRequiredApprovals(entrepriseId) {
    const policy = await this.getOrCreateDefaultPolicy(entrepriseId);

    return {
      needsManager: policy.require_manager_approval,
      needsAdmin: policy.require_admin_approval,
    };
  }

  /**
   * Créer ou mettre à jour la politique d'une entreprise
   */
  static async createOrUpdatePolicy(entrepriseId, policyData, options = {}) {
    const validFields = [
      'allow_modify_validated',
      'allow_cancel_validated',
      'min_notice_days',
      'max_backdate_days',
      'require_manager_approval',
      'require_admin_approval',
    ];

    // Filtrer les données
    const sanitizedData = {};
    validFields.forEach(field => {
      if (field in policyData) {
        sanitizedData[field] = policyData[field];
      }
    });

    // Validation basique
    if (sanitizedData.min_notice_days !== undefined && sanitizedData.min_notice_days < 0) {
      throw new Error('min_notice_days ne peut pas être négatif');
    }

    if (sanitizedData.max_backdate_days !== undefined && sanitizedData.max_backdate_days < 0) {
      throw new Error('max_backdate_days ne peut pas être négatif');
    }

    let policy = await LeavePolicy.findOne({
      where: { entreprise_id: entrepriseId },
    });

    if (policy) {
      // Mise à jour
      await policy.update(sanitizedData, {
        userId: options.userId,
        transaction: options.transaction,
      });
    } else {
      // Création
      policy = await LeavePolicy.create(
        {
          entreprise_id: entrepriseId,
          ...sanitizedData,
        },
        {
          userId: options.userId,
          transaction: options.transaction,
        }
      );
    }

    return policy;
  }
}

module.exports = LeavePolicyService;
