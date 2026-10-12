const crypto = require('crypto');
const absenceService = require('../services/absenceService');
const { Absence, Utilisateur, sequelize } = require('../models');
const logger = require('../utils/logger');
const { auditEntity } = require('../services/auditHelper');
const { notifyConfiguredManagerEvent, notifyAdminsInformationEvent } = require('../services/managerEventNotificationService');
const { formatDateFR } = require('../utils/dateFormatter');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_STATUTS = ['signalée', 'approuvée', 'rejetée'];

function formatBytes(bytes, decimals = 1) {
  if (!bytes || bytes === 0) return '0 Octet';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Octets', 'Ko', 'Mo', 'Go'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

// POST /api/absences
exports.createAbsence = async (req, res, next) => {
  try {
    const { type_absence, date_debut, date_fin, commentaire } = req.body;
    const utilisateur_id = ['employe', 'apprenti'].includes(req.user.role) ? req.user.id : (req.body.utilisateur_id || req.user.id);
    const entreprise_id = req.user.entreprise_id;

    // C-3: super_admin sans entreprise_id ne peut pas créer d'absence
    if (!entreprise_id) {
      return res.status(400).json({ message: 'Impossible de créer une absence sans entreprise associée.' });
    }

    // m-3: validation UUID sur utilisateur_id fourni manuellement
    if (req.body.utilisateur_id && !UUID_RE.test(req.body.utilisateur_id)) {
      return res.status(400).json({ message: 'utilisateur_id invalide.' });
    }

    // Vérification IDOR : l'utilisateur cible doit appartenir à la même entreprise
    if (utilisateur_id !== req.user.id) {
      const cible = await Utilisateur.findByPk(utilisateur_id, { attributes: ['entreprise_id'] });
      if (!cible || cible.entreprise_id !== entreprise_id) {
        return res.status(403).json({ message: "Vous ne pouvez pas créer une absence pour un utilisateur d'une autre entreprise." });
      }
    }

    let justificatif_metadata = null;
    let attachment = null;
    let justificatif = null;

    if (req.file) {
      const hash = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
      justificatif = req.file.originalname;
      justificatif_metadata = {
        nom_original: req.file.originalname,
        taille_octets: req.file.size,
        taille_formatee: formatBytes(req.file.size),
        type_mime: req.file.mimetype,
        date_depot: new Date().toISOString(),
        sha256: hash,
      };
      attachment = {
        filename: req.file.originalname,
        content: req.file.buffer,
        contentType: req.file.mimetype,
      };
    }

    await absenceService.assertManagerAbsenceAction(req.user, utilisateur_id, type_absence);
    const absence = await absenceService.createAbsence({
      utilisateur_id,
      entreprise_id,
      type_absence,
      date_debut,
      date_fin,
      commentaire,
      justificatif,
      justificatif_metadata,
      attachment,
    });
    // M-1: audit trail
    await auditEntity({
      action: 'ABSENCE_CREATED',
      entity: 'Absence',
      entityId: absence.id,
      performedBy: req.user,
      req,
      metadata: {
        type_absence,
        date_debut,
        date_fin,
        utilisateur_id,
        has_justificatif: Boolean(req.file),
        justificatif_nom: req.file?.originalname || null,
      },
    });
    res.status(201).json(absence);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ message: err.message });
    next(err);
  }
};

// GET /api/absences
exports.listAbsences = async (req, res, next) => {
  try {
    const absences = await absenceService.listAbsences(req.user, req.query);
    res.json(absences);
  } catch (err) {
    logger.error('Erreur récupération absences', { error: err.message });
    next(err);
  }
};

// PATCH /api/absences/:id
exports.updateAbsence = async (req, res, next) => {
  try {
    const absence = await Absence.findByPk(req.params.id);
    if (!absence) return res.status(404).json({ message: 'Absence non trouvée' });
    if (req.user.role !== 'super_admin' && absence.entreprise_id !== req.user.entreprise_id) {
      return res.status(403).json({ message: 'Accès interdit' });
    }
    const canEdit = ['manager', 'admin_entreprise', 'super_admin'].includes(req.user.role)
      || (['employe', 'apprenti'].includes(req.user.role) && absence.utilisateur_id === req.user.id);
    if (!canEdit) return res.status(403).json({ message: 'Accès interdit' });
    await absenceService.assertManagerAbsenceAction(req.user, absence.utilisateur_id, absence.type_absence);

    const canUpdateStatut = ['manager', 'admin_entreprise', 'super_admin'].includes(req.user.role);

    // C-4: gestion du statut (approbation/rejet) — endpoint manquant jusqu'ici
    if (req.body.statut !== undefined) {
      if (!canUpdateStatut) return res.status(403).json({ message: 'Seuls les managers et admins peuvent modifier le statut.' });
      if (!VALID_STATUTS.includes(req.body.statut)) return res.status(400).json({ message: 'Statut invalide.' });
      absence.statut = req.body.statut;
    }

    // m-1: !== undefined pour permettre de vider le commentaire (if falsy l'ignorait)
    // M-2: limite de longueur sur le champ TEXT illimité
    if (req.body.commentaire !== undefined) {
      if (typeof req.body.commentaire !== 'string') return res.status(400).json({ message: 'commentaire invalide.' });
      if (req.body.commentaire.length > 5000) return res.status(400).json({ message: 'commentaire trop long (max 5000 caractères).' });
      // Un employé ne peut modifier son commentaire que si l'absence est encore signalée
      const isEmployee = ['employe', 'apprenti'].includes(req.user.role);
      if (isEmployee && absence.statut !== 'signalée') {
        return res.status(409).json({ message: 'Impossible de modifier une absence déjà approuvée ou rejetée.' });
      }
      absence.commentaire = req.body.commentaire;
    }

    const previousStatus = absence.previous('statut');
    const statusChanged = req.body.statut !== undefined && previousStatus !== absence.statut;
    const commentChanged = absence.changed('commentaire');
    await sequelize.transaction(async transaction => {
      await absence.save({ transaction });
      if (statusChanged || commentChanged) {
        const employee = await Utilisateur.findByPk(absence.utilisateur_id, {
          attributes: ['id', 'prenom', 'nom', 'service'], transaction,
        });
        const event = {
          entrepriseId: absence.entreprise_id, service: employee?.service, category: absence.type_absence,
          type: statusChanged ? 'absence_statut_modifie' : 'absence_modifiee',
          message: `L’absence ${absence.type_absence === 'maladie' ? 'maladie' : 'exceptionnelle'} de ${employee?.prenom || ''} ${employee?.nom || ''} du ${formatDateFR(absence.date_debut)} au ${formatDateFR(absence.date_fin)} ${statusChanged ? `est maintenant ${absence.statut}` : 'a été modifiée'}.`,
          url: '/absences/equipe', excludeUserIds: [req.user.id, absence.utilisateur_id], transaction,
        };
        if (statusChanged) await notifyConfiguredManagerEvent(event);
        await notifyAdminsInformationEvent(event);
      }
    });
    // M-1: audit trail
    await auditEntity({ action: 'ABSENCE_UPDATED', entity: 'Absence', entityId: absence.id, performedBy: req.user, req, metadata: { updates: req.body } });
    res.json(absence);
  } catch (err) {
    logger.error('Erreur mise à jour absence', { error: err.message });
    next(err);
  }
};

// DELETE /api/absences/:id
exports.deleteAbsence = async (req, res, next) => {
  try {
    await absenceService.deleteAbsence(req.params.id, req.user);
    // M-1: audit trail
    await auditEntity({ action: 'ABSENCE_DELETED', entity: 'Absence', entityId: req.params.id, performedBy: req.user, req });
    res.status(204).send();
  } catch (err) {
    if (err.status) return res.status(err.status).json({ message: err.message });
    next(err);
  }
};
