const { Absence, Utilisateur } = require('../models');
const emailService = require('./emailService');
const logger = require('../utils/logger');
const { Op } = require('sequelize');
const { formatDateFR } = require('../utils/dateFormatter');

async function notifyAbsenceCreated(absence, entreprise_id) {
  try {
    const [employe, admin] = await Promise.all([
      Utilisateur.findByPk(absence.utilisateur_id),
      Utilisateur.findOne({ where: { entreprise_id, role: 'admin_entreprise' } }),
    ]);

    // Notifier en priorité les managers du même service que l'employé.
    // Fallback : tous les managers actifs de l'entreprise si aucun n'est dans ce service.
    let managers = [];
    if (employe?.service) {
      managers = await Utilisateur.findAll({
        where: { entreprise_id, role: 'manager', service: employe.service, statut: 'actif' },
      });
    }
    if (managers.length === 0) {
      managers = await Utilisateur.findAll({
        where: { entreprise_id, role: 'manager', statut: 'actif' },
      });
    }

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

    const recipients = [];

    if (employe?.email) {
      recipients.push(emailService.sendEmail(
        employe.email,
        'Nouvelle absence enregistrée',
        'absence-notification',
        { ...base, content: `<p>Bonjour ${employe.prenom},<br>Votre absence (${absence.type_absence}) du ${formatDateFR(absence.date_debut)} au ${formatDateFR(absence.date_fin)} a bien été enregistrée.<br>Commentaire : ${absence.commentaire}</p>` }
      ));
    }

    if (admin?.email) {
      recipients.push(emailService.sendEmail(
        admin.email,
        'Nouvelle absence déclarée',
        'absence-notification',
        { ...base, content: `<p>Nouvelle absence déclarée par ${employe?.prenom} ${employe?.nom} (${employe?.email}) du ${formatDateFR(absence.date_debut)} au ${formatDateFR(absence.date_fin)}.<br>Type : ${absence.type_absence}<br>Commentaire : ${absence.commentaire}</p>` }
      ));
    }

    for (const manager of managers) {
      if (manager.email) {
        recipients.push(emailService.sendEmail(
          manager.email,
          'Nouvelle absence dans votre équipe',
          'absence-notification',
          { ...base, content: `<p>Nouvelle absence déclarée par ${employe?.prenom} ${employe?.nom} (${employe?.email}) du ${formatDateFR(absence.date_debut)} au ${formatDateFR(absence.date_fin)}.<br>Type : ${absence.type_absence}<br>Commentaire : ${absence.commentaire}</p>` }
        ));
      }
    }

    await Promise.allSettled(recipients);
  } catch (err) {
    logger.error('Erreur envoi email absence', { error: err.message });
  }
}

async function createAbsence({ utilisateur_id, entreprise_id, type_absence, date_debut, date_fin, commentaire }) {
  if (!type_absence || !date_debut || !date_fin || !commentaire?.trim()) {
    throw Object.assign(new Error('Tous les champs obligatoires doivent être remplis, y compris le commentaire.'), { status: 400 });
  }
  if (new Date(date_fin) < new Date(date_debut)) {
    throw Object.assign(new Error('La date de fin doit être postérieure ou égale à la date de début'), { status: 400 });
  }

  // Fix #45 : vérification de chevauchement avant création.
  // Deux intervalles [A,B] et [C,D] se chevauchent si A <= D et B >= C.
  const existing = await Absence.findOne({
    where: {
      utilisateur_id,
      date_debut: { [Op.lte]: date_fin },
      date_fin:   { [Op.gte]: date_debut },
    },
    attributes: ['id', 'date_debut', 'date_fin'],
  });
  if (existing) {
    throw Object.assign(
      new Error(
        `Une absence existe déjà sur cette période ` +
        `(du ${formatDateFR(existing.date_debut)} au ${formatDateFR(existing.date_fin)}). ` +
        `Veuillez choisir une période différente.`
      ),
      { status: 409 }
    );
  }

  const absence = await Absence.create({ utilisateur_id, entreprise_id, type_absence, date_debut, date_fin, commentaire });

  notifyAbsenceCreated(absence, entreprise_id);

  return absence;
}

// Rôles pouvant voir le commentaire d'un arrêt maladie d'un collègue (RGPD Art. 9)
const MEDICAL_COMMENT_ROLES = ['manager', 'admin_entreprise', 'super_admin'];

async function listAbsences({ role, id: userId, entreprise_id }, query) {
  const { type_absence, utilisateur_id, date_debut, date_fin } = query;
  const where = { entreprise_id };

  if (utilisateur_id) {
    where.utilisateur_id = utilisateur_id;
  }

  if (type_absence) where.type_absence = type_absence;

  // Overlap : retourner toute absence qui chevauche la période demandée
  if (date_debut && date_fin) {
    where.date_debut = { [Op.lte]: date_fin };
    where.date_fin   = { [Op.gte]: date_debut };
  } else {
    if (date_debut) where.date_debut = { [Op.gte]: date_debut };
    if (date_fin)   where.date_fin   = { [Op.lte]: date_fin };
  }

  const rows = await Absence.findAll({
    where,
    include: [{ model: Utilisateur, as: 'utilisateur', attributes: ['id', 'prenom', 'nom', 'role'] }],
    order: [['date_debut', 'DESC']],
  });

  // RGPD Art. 9 — le commentaire d'un arrêt maladie est une donnée de santé.
  // Il est masqué pour les employés qui consultent l'absence d'un collègue.
  // L'employé voit son propre commentaire ; manager/admin voient tout.
  if (MEDICAL_COMMENT_ROLES.includes(role)) return rows;

  return rows.map(absence => {
    if (absence.type_absence === 'maladie' && absence.utilisateur_id !== userId) {
      const plain = absence.toJSON();
      plain.commentaire = null;
      return plain;
    }
    return absence;
  });
}

async function deleteAbsence(id, user) {
  const absence = await Absence.findByPk(id);
  if (!absence) throw Object.assign(new Error('Absence non trouvée'), { status: 404 });

  const isSuperAdmin    = user.role === 'super_admin';
  const isAdminOrAbove  = ['admin_entreprise', 'super_admin'].includes(user.role);
  const isManager       = user.role === 'manager';
  const isOwner         = absence.utilisateur_id === user.id;
  const sameEntreprise  = absence.entreprise_id === user.entreprise_id;

  // Vérification d'appartenance à l'entreprise (sauf super_admin qui voit tout)
  if (!isSuperAdmin && !sameEntreprise) {
    throw Object.assign(new Error('Accès interdit'), { status: 403 });
  }

  // Un employé ne peut supprimer que sa propre absence encore non traitée
  if (!isSuperAdmin && !isAdminOrAbove && !isManager) {
    if (!isOwner) throw Object.assign(new Error('Accès interdit'), { status: 403 });
    if (absence.statut !== 'signalée') {
      throw Object.assign(
        new Error('Impossible de supprimer une absence déjà approuvée ou rejetée'),
        { status: 409 }
      );
    }
  }

  await absence.destroy();
}

module.exports = { createAbsence, listAbsences, notifyAbsenceCreated, deleteAbsence };
