const express = require('express');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { Parser } = require('json2csv');
const { Op } = require('sequelize');
const authorizeRole = require('../middlewares/authorizeRole');
const sequelize = require('../config/database');
const systemSettingsService = require('../services/systemSettingsService');
const emailService = require('../services/emailService');
const backupService = require('../services/backupService');
const auditActions = require('../services/auditActions');
const { AuditLog, Utilisateur, Entreprise } = require('../models');
const { initBackupCron } = require('../cron/backupCron');

const router = express.Router();

router.use(authorizeRole(['super_admin']));

function getChangedFields(before = {}, after = {}, fields = []) {
  const changed = {};
  fields.forEach((field) => {
    if (!Object.prototype.hasOwnProperty.call(after, field)) {
      return;
    }

    const beforeValue = before[field];
    const afterValue = after[field];
    if (beforeValue !== afterValue) {
      changed[field] = {
        before: beforeValue,
        after: afterValue,
      };
    }
  });

  return changed;
}

async function resolveEntrepriseId(req) {
  if (req.user?.entreprise_id) {
    return req.user.entreprise_id;
  }

  if (req.user?.id) {
    const currentUser = await Utilisateur.findByPk(req.user.id, {
      attributes: ['entreprise_id'],
    });

    if (currentUser?.entreprise_id) {
      return currentUser.entreprise_id;
    }
  }

  const firstEntreprise = await Entreprise.findOne({
    attributes: ['id'],
    order: [['created_at', 'ASC']],
  });

  return firstEntreprise?.id || null;
}

async function logSettingsAudit(req, action, metadata = {}) {
  const entrepriseId = await resolveEntrepriseId(req);
  if (!entrepriseId) {
    return;
  }

  await AuditLog.create({
    action,
    entity: 'system_settings',
    entity_id: null,
    user_id: req.user?.id || null,
    entreprise_id: entrepriseId,
    ip_address: req.ip,
    user_agent: req.get('User-Agent'),
    metadata,
  });
}

router.get('/', async (req, res, next) => {
  try {
    const settings = await systemSettingsService.getSettings();
    res.json(settings);
  } catch (error) {
    next(error);
  }
});

router.put('/', async (req, res, next) => {
  try {
    const previous = await systemSettingsService.getSettings();
    const updated = await systemSettingsService.updateSettings(req.body || {}, req.user?.id);

    const changedFields = getChangedFields(previous, updated, Object.keys(req.body || {}));
    await logSettingsAudit(req, auditActions.SYSTEM_SETTINGS_UPDATED, {
      scope: 'global',
      changedFields,
    });

    res.json({
      message: 'Paramètres mis à jour avec succès',
      settings: updated,
    });
  } catch (error) {
    next(error);
  }
});

router.put('/sections/:section', async (req, res, next) => {
  try {
    const previous = await systemSettingsService.getSettings();
    const updated = await systemSettingsService.updateSection(req.params.section, req.body || {}, req.user?.id);

    const changedFields = getChangedFields(previous, updated, Object.keys(req.body || {}));
    await logSettingsAudit(req, auditActions.SYSTEM_SETTINGS_UPDATED, {
      scope: req.params.section,
      changedFields,
    });

    // Recharger le cron de sauvegarde si les paramètres base de données changent
    if (req.params.section === 'database') {
      await initBackupCron();
    }

    res.json({
      message: `Section ${req.params.section} mise à jour`,
      settings: updated,
    });
  } catch (error) {
    next(error);
  }
});

function getSettingsHistoryWhere() {
  return {
    entity: 'system_settings',
    action: {
      [Op.in]: [
        auditActions.SYSTEM_SETTINGS_UPDATED,
        auditActions.SYSTEM_BACKUP_CREATED,
        auditActions.SYSTEM_MAINTENANCE_TOGGLED,
        auditActions.SYSTEM_RESTART_REQUESTED,
        auditActions.SYSTEM_TEST_EMAIL_SENT,
      ],
    },
  };
}

router.get('/history/csv', async (req, res, next) => {
  try {
    const logs = await AuditLog.findAll({
      where: {
        ...getSettingsHistoryWhere(),
        user_id: {
          [Op.ne]: null,
        },
      },
      include: [
        {
          model: Utilisateur,
          as: 'utilisateur',
          attributes: ['prenom', 'nom', 'email'],
          required: true,
        },
      ],
      order: [['created_at', 'DESC']],
      limit: 1000,
    });

    const rows = logs.map((log) => {
      const actor = log.utilisateur
        ? [log.utilisateur.prenom, log.utilisateur.nom].filter(Boolean).join(' ').trim() || log.utilisateur.email
        : 'Inconnu';

      return {
        date: new Date(log.createdAt).toISOString(),
        action: log.action,
        acteur: actor,
        email_acteur: log.utilisateur?.email || '',
        ip: log.ip_address || '',
        details: JSON.stringify(log.metadata || {}),
      };
    });

    const parser = new Parser({
      fields: ['date', 'action', 'acteur', 'email_acteur', 'ip', 'details'],
    });
    const csv = parser.parse(rows);

    const filename = `settings_history_${new Date().toISOString().slice(0, 10)}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.status(200).send(csv);
  } catch (error) {
    return next(error);
  }
});

router.get('/history', async (req, res, next) => {
  try {
    const requestedPage = Number(req.query.page || 1);
    const requestedPageSize = Number(req.query.pageSize || req.query.limit || 20);
    const page = Number.isNaN(requestedPage) ? 1 : Math.max(1, requestedPage);
    const pageSize = Number.isNaN(requestedPageSize) ? 20 : Math.max(1, Math.min(100, requestedPageSize));
    const offset = (page - 1) * pageSize;

    const allowedSortBy = ['date', 'action', 'actor'];
    const requestedSortBy = String(req.query.sortBy || 'date').toLowerCase();
    const sortBy = allowedSortBy.includes(requestedSortBy) ? requestedSortBy : 'date';
    const requestedSortOrder = String(req.query.sortOrder || 'desc').toLowerCase();
    const sortOrder = requestedSortOrder === 'asc' ? 'ASC' : 'DESC';

    let order = [['created_at', 'DESC']];
    if (sortBy === 'date') {
      order = [['created_at', sortOrder]];
    } else if (sortBy === 'action') {
      order = [['action', sortOrder], ['created_at', 'DESC']];
    } else if (sortBy === 'actor') {
      order = [
        [{ model: Utilisateur, as: 'utilisateur' }, 'nom', sortOrder],
        [{ model: Utilisateur, as: 'utilisateur' }, 'prenom', sortOrder],
        [{ model: Utilisateur, as: 'utilisateur' }, 'email', sortOrder],
        ['created_at', 'DESC'],
      ];
    }

    const where = {
      ...getSettingsHistoryWhere(),
      user_id: {
        [Op.ne]: null,
      },
    };

    const { rows: logs, count: total } = await AuditLog.findAndCountAll({
      where,
      include: [
        {
          model: Utilisateur,
          as: 'utilisateur',
          attributes: ['id', 'prenom', 'nom', 'email'],
          required: true,
        },
      ],
      order,
      limit: pageSize,
      offset,
    });

    res.json({
      logs,
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
      },
      sort: {
        sortBy,
        sortOrder: sortOrder.toLowerCase(),
      },
    });
  } catch (error) {
    next(error);
  }
});

router.get('/system-info', async (req, res, next) => {
  try {
    const settings = await systemSettingsService.getSettings();

    let dbStatus = 'disconnected';
    try {
      await sequelize.authenticate();
      dbStatus = 'connected';
    } catch (error) {
      dbStatus = 'disconnected';
    }

    res.json({
      nodeVersion: process.version,
      platform: `${os.type()} ${os.release()} (${os.arch()})`,
      memory: `${Math.round(os.totalmem() / (1024 * 1024 * 1024))} GB`,
      freeMemory: `${Math.round(os.freemem() / (1024 * 1024 * 1024))} GB`,
      cores: os.cpus()?.length || 0,
      uptime: Math.floor(process.uptime()),
      dbStatus,
      maintenanceMode: Boolean(settings.maintenanceMode),
      lastBackupAt: settings.lastBackupAt,
      updatedAt: settings.updatedAt,
    });
  } catch (error) {
    next(error);
  }
});

router.post('/actions/backup', async (req, res, next) => {
  try {
    const backup = await backupService.runDatabaseBackup();

    const updated = await systemSettingsService.updateSettings({
      lastBackupAt: new Date().toISOString(),
    }, req.user?.id);

    await logSettingsAudit(req, auditActions.SYSTEM_BACKUP_CREATED, {
      filename: backup.filename,
      sizeBytes: backup.sizeBytes,
    });

    res.json({
      message: 'Sauvegarde SQL créée avec succès.',
      settings: updated,
      backup: {
        filename: backup.filename,
        sizeBytes: backup.sizeBytes,
        createdAt: backup.createdAt,
        downloadUrl: `/api/settings/backups/${backup.filename}`,
      },
    });
  } catch (error) {
    next(error);
  }
});

router.get('/backups/:filename', async (req, res, next) => {
  try {
    const filePath = backupService.getBackupPathByFilename(req.params.filename);
    if (!filePath) {
      return res.status(400).json({ message: 'Nom de fichier invalide.' });
    }

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ message: 'Sauvegarde introuvable.' });
    }

    return res.download(filePath, path.basename(filePath));
  } catch (error) {
    return next(error);
  }
});

router.post('/actions/maintenance', async (req, res, next) => {
  try {
    const { enabled, maintenanceMessage } = req.body || {};
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ message: 'Le champ enabled (boolean) est requis.' });
    }

    const payload = {
      maintenanceMode: enabled,
    };

    if (typeof maintenanceMessage === 'string' && maintenanceMessage.trim()) {
      payload.maintenanceMessage = maintenanceMessage.trim();
    }

    const updated = await systemSettingsService.updateSettings({
      ...payload,
    }, req.user?.id);

    await logSettingsAudit(req, auditActions.SYSTEM_MAINTENANCE_TOGGLED, {
      enabled,
      maintenanceMessage: updated.maintenanceMessage,
    });

    res.json({
      message: enabled ? 'Mode maintenance activé.' : 'Mode maintenance désactivé.',
      settings: updated,
    });
  } catch (error) {
    next(error);
  }
});

router.post('/actions/restart', async (req, res) => {
  await logSettingsAudit(req, auditActions.SYSTEM_RESTART_REQUESTED, {
    requestedAt: new Date().toISOString(),
  });

  res.json({
    message: 'Redémarrage des services demandé (simulation).',
    executedAt: new Date().toISOString(),
  });
});

router.post('/actions/test-smtp', async (req, res, next) => {
  try {
    const nodemailer = require('nodemailer');
    const smtpConfig = await emailService.getSmtpConfig();

    if (!smtpConfig.host || !smtpConfig.user || !smtpConfig.pass) {
      return res.status(400).json({
        ok: false,
        error: 'Configuration SMTP incomplète (host/user/pass manquants)',
        config: { host: smtpConfig.host, port: smtpConfig.port, user: smtpConfig.user, hasPass: Boolean(smtpConfig.pass) },
      });
    }

    const transporter = nodemailer.createTransport({
      host: smtpConfig.host,
      port: Number(smtpConfig.port),
      secure: Boolean(smtpConfig.secure),
      auth: { user: smtpConfig.user, pass: smtpConfig.pass },
    });

    await transporter.verify();
    res.json({ ok: true, message: 'Connexion SMTP établie avec succès', config: { host: smtpConfig.host, port: smtpConfig.port, user: smtpConfig.user } });
  } catch (error) {
    res.status(502).json({ ok: false, error: error.message, code: error.code });
  }
});

router.post('/actions/test-email', async (req, res, next) => {
  try {
    const { to } = req.body || {};
    if (!to) {
      return res.status(400).json({ message: 'Le champ to est requis.' });
    }

    await emailService.sendEmail(
      to,
      'Test configuration email TeamOff',
      'default-template',
      {
        content: 'Cet email confirme que la configuration email de TeamOff fonctionne correctement.',
      }
    );

    await logSettingsAudit(req, auditActions.SYSTEM_TEST_EMAIL_SENT, {
      recipient: to,
    });

    res.json({ message: `Email de test envoyé à ${to}` });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
