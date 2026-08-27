const { Absence, Utilisateur } = require('../models');
const emailService = require('./emailService');
const logger = require('../utils/logger');
const { Op } = require('sequelize');
const { formatDateFR } = require('../utils/dateFormatter');
const sanitizeHtml = require('sanitize-html');

const VALID_ABSENCE_TYPES = ['maladie', 'absence_exceptionnelle'];

// C-2: échappement HTML pour les contenus injectés dans les templates email
function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function notifyAbsenceCreated(absence, entreprise_id) {
  try {
    // m-2: findAll pour notifier tous les admins actifs (findOne ne notifiait que le premier)
    const [employe, admins] = await Promise.all([
      Utilisateur.findByPk(absence.utilisateur_id),
      Utilisateur.findAll({ where: { entreprise_id, role: 'admin_entreprise', statut: 'actif' } }),
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
      date_debut: formatDateFR(absence.date_debut),
      date_fin: formatDateFR(absence.date_fin),
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
        { ...base, content: `<p>Bonjour ${esc(employe.prenom)},<br>Votre absence (${esc(absence.type_absence)}) du ${formatDateFR(absence.date_debut)} au ${formatDateFR(absence.date_fin)} a bien été enregistrée.<br>Commentaire : ${esc(absence.commentaire)}</p>` }
      ));
    }

    for (const admin of admins) {
      if (admin.email) {
        recipients.push(emailService.sendEmail(
          admin.email,
          'Nouvelle absence déclarée',
          'absence-notification',
          { ...base, content: `<p>Nouvelle absence déclarée par ${esc(employe?.prenom)} ${esc(employe?.nom)} (${esc(employe?.email)}) du ${formatDateFR(absence.date_debut)} au ${formatDateFR(absence.date_fin)}.<br>Type : ${esc(absence.type_absence)}<br>Commentaire : ${esc(absence.commentaire)}</p>` }
        ));
      }
    }

    for (const manager of managers) {
      if (manager.email) {
        recipients.push(emailService.sendEmail(
          manager.email,
          'Nouvelle absence dans votre équipe',
          'absence-notification',
          { ...base, content: `<p>Nouvelle absence déclarée par ${esc(employe?.prenom)} ${esc(employe?.nom)} (${esc(employe?.email)}) du ${formatDateFR(absence.date_debut)} au ${formatDateFR(absence.date_fin)}.<br>Type : ${esc(absence.type_absence)}<br>Commentaire : ${esc(absence.commentaire)}</p>` }
        ));
      }
    }

    await Promise.allSettled(recipients);
  } catch (err) {
    logger.error('Erreur envoi email absence', { error: err.message });
  }
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

async function createAbsence({ utilisateur_id, entreprise_id, type_absence, date_debut, date_fin, commentaire }) {
  if (!type_absence || !date_debut || !date_fin || !commentaire?.trim()) {
    throw Object.assign(new Error('Tous les champs obligatoires doivent être remplis, y compris le commentaire.'), { status: 400 });
  }

  if (!VALID_ABSENCE_TYPES.includes(type_absence)) {
    throw Object.assign(new Error(`Type d'absence invalide. Valeurs acceptées : ${VALID_ABSENCE_TYPES.join(', ')}`), { status: 400 });
  }

  const safeCommentaire = sanitizeHtml(String(commentaire).slice(0, 5000), { allowedTags: [], allowedAttributes: {} });

  // M-3: validation de format avant toute opération Date — new Date("bad") retourne NaN
  // ce qui fait passer silencieusement la comparaison date_fin < date_debut
  if (!ISO_DATE_RE.test(date_debut) || !ISO_DATE_RE.test(date_fin)) {
    throw Object.assign(new Error('Format de date invalide (YYYY-MM-DD attendu)'), { status: 400 });
  }
  if (isNaN(new Date(date_debut).getTime()) || isNaN(new Date(date_fin).getTime())) {
    throw Object.assign(new Error('Date invalide'), { status: 400 });
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

  const absence = await Absence.create({ utilisateur_id, entreprise_id, type_absence, date_debut, date_fin, commentaire: safeCommentaire });

  notifyAbsenceCreated(absence, entreprise_id);

  return absence;
}

// Rôles pouvant voir les données médicales d'un collègue (RGPD Art. 9)
const MEDICAL_ACCESS_ROLES = ['manager', 'admin_entreprise', 'super_admin'];

async function listAbsences({ role, id: userId, entreprise_id }, query) {
  const { type_absence, date_debut, date_fin } = query;
  const utilisateur_id_filter = query.utilisateur_id;

  const RESTRICTED_ROLES = ['employe', 'apprenti'];
  const isRestricted = RESTRICTED_ROLES.includes(role);

  const where = {};

  // M-4: super_admin peut cibler une entreprise spécifique via query.entreprise_id
  if (role === 'super_admin') {
    if (query.entreprise_id) where.entreprise_id = query.entreprise_id;
    else if (entreprise_id) where.entreprise_id = entreprise_id;
    // sans filtre : toutes les entreprises (privilège super_admin)
  } else {
    where.entreprise_id = entreprise_id;
  }

  // C-1: un employé/apprenti ne peut consulter que ses propres absences
  if (isRestricted) {
    where.utilisateur_id = userId;
  } else if (utilisateur_id_filter) {
    where.utilisateur_id = utilisateur_id_filter;
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
    include: [{ model: Utilisateur, as: 'utilisateur', attributes: ['id', 'prenom', 'nom', 'role', 'service'] }],
    order: [['date_debut', 'DESC']],
  });

  // RGPD Art. 9 — le commentaire ET le type d'une absence maladie sont des données de santé.
  // Masqués pour les employés qui consulteraient l'absence d'un collègue.
  // (C-1 force déjà les employés à ne voir que leurs propres absences ; ce guard reste
  // actif pour toute future évolution des droits.)
  if (MEDICAL_ACCESS_ROLES.includes(role)) return rows;

  return rows.map(absence => {
    if (absence.utilisateur_id !== userId && absence.type_absence === 'maladie') {
      const plain = absence.toJSON();
      plain.commentaire = null;
      plain.type_absence = 'confidentiel';
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
