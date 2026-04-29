const absenceService = require('../services/absenceService');
const { Absence } = require('../models');
const logger = require('../utils/logger');

// POST /api/absences
exports.createAbsence = async (req, res, next) => {
  try {
    const { type_absence, date_debut, date_fin, commentaire } = req.body;
    const utilisateur_id = req.user.role === 'employe' ? req.user.id : (req.body.utilisateur_id || req.user.id);
    const entreprise_id = req.user.entreprise_id;

    const absence = await absenceService.createAbsence({
      utilisateur_id, entreprise_id, type_absence, date_debut, date_fin, commentaire,
      justificatifFile: req.file || null,
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
      || (req.user.role === 'employe' && absence.utilisateur_id === req.user.id);
    if (!canEdit) return res.status(403).json({ message: 'Accès interdit' });

    if (req.body.justificatif) absence.justificatif = req.body.justificatif;
    if (req.body.commentaire) absence.commentaire = req.body.commentaire;
    await absence.save();
    res.json(absence);
  } catch (err) {
    logger.error('Erreur mise à jour absence', { error: err.message });
    next(err);
  }
};
