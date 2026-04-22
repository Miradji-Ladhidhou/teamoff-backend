const { Absence, Utilisateur } = require('../models');
const { Op } = require('sequelize');
const emailService = require('../services/emailService');
const logger = require('../utils/logger');
const path = require('path');

// POST /api/absences
exports.createAbsence = async (req, res) => {
  try {
    const { type_absence, date_debut, date_fin, commentaire } = req.body;
    let justificatif = req.file ? `/uploads/justificatifs/${req.file.filename}` : (req.body.justificatif || null);
    const utilisateur_id = req.user.role === 'employe' ? req.user.id : (req.body.utilisateur_id || req.user.id);
    const entreprise_id = req.user.entreprise_id;
    if (!type_absence || !date_debut || !date_fin || !commentaire || commentaire.trim() === '') {
      return res.status(400).json({ message: 'Tous les champs obligatoires doivent être remplis, y compris le commentaire.' });
    }
    if (new Date(date_fin) < new Date(date_debut)) {
      return res.status(400).json({ message: 'La date de fin doit être postérieure ou égale à la date de début' });
    }
    if (type_absence === 'maladie' && !justificatif) {
      return res.status(400).json({ message: 'Un justificatif est obligatoire pour un arrêt maladie' });
    }
    const absence = await Absence.create({
      utilisateur_id,
      entreprise_id,
      type_absence,
      date_debut,
      date_fin,
      justificatif,
      commentaire
    });

    // Envoi d'emails à l'admin entreprise, au manager et à l'employé
    try {
      // Récupérer l'utilisateur (employé)
      const employe = await Utilisateur.findByPk(utilisateur_id);
      // Récupérer tous les managers de l'entreprise
      const managers = await Utilisateur.findAll({ where: { entreprise_id, role: 'manager' } });
      // Récupérer l'admin entreprise
      const admin = await Utilisateur.findOne({ where: { entreprise_id, role: 'admin_entreprise' } });

      // Préparer le contenu de l'email
      const emailData = {
        prenom: employe?.prenom || '',
        nom: employe?.nom || '',
        type_absence,
        date_debut,
        date_fin,
        commentaire,
        justificatif,
        employe_email: employe?.email || '',
        entreprise_id,
      };

      // Email à l'employé
      if (employe?.email) {
        await emailService.sendEmail(
          employe.email,
          'Nouvelle absence enregistrée',
          'absence-notification',
          {
            ...emailData,
            content: `<p>Bonjour ${employe.prenom},<br>Votre absence (${type_absence}) du ${date_debut} au ${date_fin} a bien été enregistrée.<br>Commentaire : ${commentaire}</p>`
          }
        );
      }

      // Email à l'admin entreprise
      if (admin?.email) {
        await emailService.sendEmail(
          admin.email,
          'Nouvelle absence déclarée',
          'absence-notification',
          {
            ...emailData,
            content: `<p>Nouvelle absence déclarée par ${employe.prenom} ${employe.nom} (${employe.email}) du ${date_debut} au ${date_fin}.<br>Type : ${type_absence}<br>Commentaire : ${commentaire}</p>`
          }
        );
      }

      // Email à tous les managers
      for (const manager of managers) {
        if (manager.email) {
          await emailService.sendEmail(
            manager.email,
            'Nouvelle absence dans votre équipe',
            'absence-notification',
            {
              ...emailData,
              content: `<p>Nouvelle absence déclarée par ${employe.prenom} ${employe.nom} (${employe.email}) du ${date_debut} au ${date_fin}.<br>Type : ${type_absence}<br>Commentaire : ${commentaire}</p>`
            }
          );
        }
      }
    } catch (err) {
      logger.error('Erreur envoi email absence', err);
    }
    res.status(201).json(absence);
  } catch (err) {
    logger.error('Erreur création absence', err);
    res.status(500).json({ message: 'Erreur création absence', error: err.message });
  }
};

// GET /api/absences
exports.listAbsences = async (req, res) => {
  try {
    const { type_absence, utilisateur_id, date_debut, date_fin } = req.query;
    const where = {};
    if (type_absence) where.type_absence = type_absence;
    if (utilisateur_id) where.utilisateur_id = utilisateur_id;
    if (date_debut) where.date_debut = { [Op.gte]: date_debut };
    if (date_fin) where.date_fin = { ...(where.date_fin || {}), [Op.lte]: date_fin };
    if (req.user.role === 'employe') where.utilisateur_id = req.user.id;
    if (req.user.entreprise_id) where.entreprise_id = req.user.entreprise_id;
    const absences = await Absence.findAll({
      where,
      include: [{ model: Utilisateur, as: 'utilisateur', attributes: ['id', 'prenom', 'nom', 'role'] }],
      order: [['date_debut', 'DESC']],
    });
    res.json(absences);
  } catch (err) {
    logger.error('Erreur récupération absences', err);
    res.status(500).json({ message: 'Erreur récupération absences', error: err.message });
  }
};

// PATCH /api/absences/:id
exports.updateAbsence = async (req, res) => {
  try {
    const absence = await Absence.findByPk(req.params.id);
    if (!absence) return res.status(404).json({ message: 'Absence non trouvée' });
    if (req.user.role !== 'super_admin' && absence.entreprise_id !== req.user.entreprise_id) {
      return res.status(403).json({ message: 'Accès interdit' });
    }
    // Seul l'auteur ou un admin/manager peut modifier le justificatif/commentaire
    if (["manager", "admin_entreprise", "super_admin"].includes(req.user.role) || (req.user.role === 'employe' && absence.utilisateur_id === req.user.id)) {
      if (req.body.justificatif) absence.justificatif = req.body.justificatif;
      if (req.body.commentaire) absence.commentaire = req.body.commentaire;
      await absence.save();
      return res.json(absence);
    }
    return res.status(403).json({ message: 'Accès interdit' });
  } catch (err) {
    logger.error('Erreur mise à jour absence', err);
    res.status(500).json({ message: 'Erreur mise à jour absence', error: err.message });
  }
};
