const absenceService = require('../services/absenceService');
const { Absence, Utilisateur } = require('../models');
const logger = require('../utils/logger');
const { auditEntity } = require('../services/auditHelper');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_STATUTS = ['signalée', 'approuvée', 'rejetée'];

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

    const absence = await absenceService.createAbsence({
      utilisateur_id, entreprise_id, type_absence, date_debut, date_fin, commentaire,
    });
    // M-1: audit trail
    await auditEntity({ action: 'ABSENCE_CREATED', entity: 'Absence', entityId: absence.id, performedBy: req.user, req, metadata: { type_absence, date_debut, date_fin, utilisateur_id } });
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
      absence.commentaire = req.body.commentaire;
    }

    await absence.save();
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
