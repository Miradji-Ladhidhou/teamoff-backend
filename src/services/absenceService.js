const { Absence, Utilisateur } = require('../models');
const emailService = require('./emailService');
const logger = require('../utils/logger');
const { Op } = require('sequelize');

async function notifyAbsenceCreated(absence, entreprise_id, justificatifFile) {
  try {
    const [employe, managers, admin] = await Promise.all([
      Utilisateur.findByPk(absence.utilisateur_id),
      Utilisateur.findAll({ where: { entreprise_id, role: 'manager' } }),
      Utilisateur.findOne({ where: { entreprise_id, role: 'admin_entreprise' } }),
    ]);

    const base = {
      prenom: employe?.prenom || '',
      nom: employe?.nom || '',
      type_absence: absence.type_absence,
      date_debut: absence.date_debut,
      date_fin: absence.date_fin,
      commentaire: absence.commentaire,
      employe_email: employe?.email || '',
      entreprise_id,
    };

    // Pièce jointe construite une seule fois, réutilisée pour tous les destinataires
    const attachments = justificatifFile ? [{
      filename: justificatifFile.originalname,
      content: justificatifFile.buffer,
      contentType: justificatifFile.mimetype,
    }] : [];

    const recipients = [];

    if (employe?.email) {
      recipients.push(emailService.sendEmail(
        employe.email,
        'Nouvelle absence enregistrée',
        'absence-notification',
        { ...base, content: `<p>Bonjour ${employe.prenom},<br>Votre absence (${absence.type_absence}) du ${absence.date_debut} au ${absence.date_fin} a bien été enregistrée.<br>Commentaire : ${absence.commentaire}${justificatifFile ? '<br><em>Justificatif en pièce jointe.</em>' : ''}</p>` },
        attachments
      ));
    }

    if (admin?.email) {
      recipients.push(emailService.sendEmail(
        admin.email,
        'Nouvelle absence déclarée',
        'absence-notification',
        { ...base, content: `<p>Nouvelle absence déclarée par ${employe?.prenom} ${employe?.nom} (${employe?.email}) du ${absence.date_debut} au ${absence.date_fin}.<br>Type : ${absence.type_absence}<br>Commentaire : ${absence.commentaire}${justificatifFile ? '<br><em>Justificatif en pièce jointe.</em>' : ''}</p>` },
        attachments
      ));
    }

    for (const manager of managers) {
      if (manager.email) {
        recipients.push(emailService.sendEmail(
          manager.email,
          'Nouvelle absence dans votre équipe',
          'absence-notification',
          { ...base, content: `<p>Nouvelle absence déclarée par ${employe?.prenom} ${employe?.nom} (${employe?.email}) du ${absence.date_debut} au ${absence.date_fin}.<br>Type : ${absence.type_absence}<br>Commentaire : ${absence.commentaire}${justificatifFile ? '<br><em>Justificatif en pièce jointe.</em>' : ''}</p>` },
          attachments
        ));
      }
    }

    await Promise.allSettled(recipients);
  } catch (err) {
    logger.error('Erreur envoi email absence', { error: err.message });
  }
}

async function createAbsence({ utilisateur_id, entreprise_id, type_absence, date_debut, date_fin, commentaire, justificatifFile }) {
  if (!type_absence || !date_debut || !date_fin || !commentaire?.trim()) {
    throw Object.assign(new Error('Tous les champs obligatoires doivent être remplis, y compris le commentaire.'), { status: 400 });
  }
  if (new Date(date_fin) < new Date(date_debut)) {
    throw Object.assign(new Error('La date de fin doit être postérieure ou égale à la date de début'), { status: 400 });
  }
  if (type_absence === 'maladie' && !justificatifFile) {
    throw Object.assign(new Error('Un justificatif est obligatoire pour un arrêt maladie'), { status: 400 });
  }

  // On note en BDD qu'un justificatif a été transmis par email, sans stocker le fichier
  const justificatif = justificatifFile ? 'piece_jointe_email' : null;

  const absence = await Absence.create({ utilisateur_id, entreprise_id, type_absence, date_debut, date_fin, justificatif, commentaire });

  // Email non bloquant — échec silencieux loggé dans notifyAbsenceCreated
  notifyAbsenceCreated(absence, entreprise_id, justificatifFile);

  return absence;
}

async function listAbsences({ role, id: userId, entreprise_id }, query) {
  const { type_absence, utilisateur_id, date_debut, date_fin } = query;
  const where = { entreprise_id };

  if (role === 'employe') {
    where.utilisateur_id = userId;
  } else if (utilisateur_id) {
    where.utilisateur_id = utilisateur_id;
  }

  if (type_absence) where.type_absence = type_absence;
  if (date_debut) where.date_debut = { [Op.gte]: date_debut };
  if (date_fin) where.date_fin = { ...(where.date_fin || {}), [Op.lte]: date_fin };

  return Absence.findAll({
    where,
    include: [{ model: Utilisateur, as: 'utilisateur', attributes: ['id', 'prenom', 'nom', 'role'] }],
    order: [['date_debut', 'DESC']],
  });
}

module.exports = { createAbsence, listAbsences, notifyAbsenceCreated };
