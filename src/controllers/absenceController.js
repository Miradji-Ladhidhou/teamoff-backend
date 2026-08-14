const absenceService = require('../services/absenceService');
const { Absence, Utilisateur } = require('../models');
const logger = require('../utils/logger');

// POST /api/absences
exports.createAbsence = async (req, res, next) => {
  try {
    const { type_absence, date_debut, date_fin, commentaire } = req.body;
    const utilisateur_id = ['employe', 'apprenti'].includes(req.user.role) ? req.user.id : (req.body.utilisateur_id || req.user.id);
    const entreprise_id = req.user.entreprise_id;

    // Vérification IDOR : l'utilisateur cible doit appartenir à la même entreprise
    if (utilisateur_id !== req.user.id) {
      const cible = await Utilisateur.findByPk(utilisateur_id, { attributes: ['entreprise_id'] });
      if (!cible || cible.entreprise_id !== entreprise_id) {
        return res.status(403).json({ message: 'Vous ne pouvez pas créer une absence pour un utilisateur d\'une autre entreprise.' });
      }
    }

    const absence = await absenceService.createAbsence({
      utilisateur_id, entreprise_id, type_absence, date_debut, date_fin, commentaire,
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

    if (req.body.commentaire) absence.commentaire = req.body.commentaire;
    await absence.save();
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
    res.status(204).send();
  } catch (err) {
    if (err.status) return res.status(err.status).json({ message: err.message });
    next(err);
  }
};
