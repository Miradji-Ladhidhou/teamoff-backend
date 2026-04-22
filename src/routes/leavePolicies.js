/**
 * Routes pour la gestion des politiques de congés par entreprise
 * Accès : admin_entreprise et super_admin uniquement
 */

const express = require('express');
const logger = require('../utils/logger');
const router = express.Router();
const { LeavePolicy } = require('../models');
const LeavePolicyService = require('../services/leavePolicyService');
const authJwt = require('../middlewares/authJwt');
const authorizeRole = require('../middlewares/authorizeRole');

/**
 * GET /leave-policies
 * Récupérer la politique de congés de l'entreprise connectée
 * Accès : admin_entreprise, super_admin
 */
router.get(
  '/',
  authJwt,
  authorizeRole(['admin_entreprise', 'super_admin']),
  async (req, res) => {
    try {
      const entrepriseId = req.user.role === 'super_admin'
        ? (req.query.entreprise_id || req.user.entreprise_id)
        : req.user.entreprise_id;

      if (!entrepriseId) {
        return res.status(400).json({ error: 'Pas d\'entreprise spécifiée' });
      }

      const policy = await LeavePolicyService.getOrCreateDefaultPolicy(entrepriseId);

      res.json({
        success: true,
        data: policy,
      });
    } catch (error) {
      logger.error('Erreur lors de la récupération de la politique:', error);
      res.status(500).json({
        error: 'Erreur lors de la récupération de la politique',
      });
    }
  }
);

/**
 * PUT /leave-policies
 * Mettre à jour la politique de congés de l'entreprise
 * Accès : admin_entreprise, super_admin
 */
router.put(
  '/',
  authJwt,
  authorizeRole(['admin_entreprise', 'super_admin']),
  async (req, res) => {
    try {
      const entrepriseId = req.user.role === 'super_admin'
        ? (req.body.entreprise_id || req.user.entreprise_id)
        : req.user.entreprise_id;

      if (!entrepriseId) {
        return res.status(400).json({ error: 'Pas d\'entreprise spécifiée' });
      }

      // Valider les données
      const {
        allow_modify_validated,
        allow_cancel_validated,
        min_notice_days,
        max_backdate_days,
        require_manager_approval,
        require_admin_approval,
      } = req.body;

      const policyData = {};

      if (allow_modify_validated !== undefined) {
        policyData.allow_modify_validated = Boolean(allow_modify_validated);
      }

      if (allow_cancel_validated !== undefined) {
        policyData.allow_cancel_validated = Boolean(allow_cancel_validated);
      }

      if (min_notice_days !== undefined) {
        const value = parseInt(min_notice_days, 10);
        if (isNaN(value) || value < 0) {
          return res.status(400).json({
            error: 'min_notice_days doit être un nombre >= 0',
          });
        }
        policyData.min_notice_days = value;
      }

      if (max_backdate_days !== undefined) {
        const value = parseInt(max_backdate_days, 10);
        if (isNaN(value) || value < 0) {
          return res.status(400).json({
            error: 'max_backdate_days doit être un nombre >= 0',
          });
        }
        policyData.max_backdate_days = value;
      }

      if (require_manager_approval !== undefined) {
        policyData.require_manager_approval = Boolean(require_manager_approval);
      }

      if (require_admin_approval !== undefined) {
        policyData.require_admin_approval = Boolean(require_admin_approval);
      }

      const policy = await LeavePolicyService.createOrUpdatePolicy(
        entrepriseId,
        policyData,
        {
          userId: req.user.id,
        }
      );

      res.json({
        success: true,
        message: 'Politique mise à jour',
        data: policy,
      });
    } catch (error) {
      logger.error('Erreur lors de la mise à jour de la politique:', error);
      res.status(500).json({
        error: error.message || 'Erreur lors de la mise à jour de la politique',
      });
    }
  }
);

/**
 * POST /leave-policies/validate-modification
 * Valider si une modification de congé est autorisée
 * Accès : authentifié
 * (endpoint public pour vérification avant action)
 */
router.post(
  '/validate-modification',
  authJwt,
  async (req, res) => {
    try {
      const {
        conge_id,
        conge_status,
        conge_start_date,
      } = req.body;

      if (!conge_id || !conge_status || !conge_start_date) {
        return res.status(400).json({
          error: 'Paramètres manquants',
        });
      }

      const result = await LeavePolicyService.validateModification({
        entrepriseId: req.user.entreprise_id,
        congeStatus: conge_status,
        congeStartDate: new Date(conge_start_date),
        initiatorRole: req.user.role,
      });

      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      logger.error('Erreur lors de la validation:', error);
      res.status(500).json({
        error: 'Erreur lors de la validation',
      });
    }
  }
);

/**
 * POST /leave-policies/validate-cancellation
 * Valider si une annulation de congé est autorisée
 * Accès : authentifié
 */
router.post(
  '/validate-cancellation',
  authJwt,
  async (req, res) => {
    try {
      const {
        conge_id,
        conge_status,
        conge_start_date,
      } = req.body;

      if (!conge_id || !conge_status || !conge_start_date) {
        return res.status(400).json({
          error: 'Paramètres manquants',
        });
      }

      const result = await LeavePolicyService.validateCancellation({
        entrepriseId: req.user.entreprise_id,
        congeStatus: conge_status,
        congeStartDate: new Date(conge_start_date),
        initiatorRole: req.user.role,
      });

      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      logger.error('Erreur lors de la validation:', error);
      res.status(500).json({
        error: 'Erreur lors de la validation',
      });
    }
  }
);

module.exports = router;
