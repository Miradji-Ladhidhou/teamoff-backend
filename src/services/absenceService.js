const { Absence, Utilisateur, Entreprise, sequelize } = require('../models');
const emailService = require('./emailService');
const logger = require('../utils/logger');
const { Op } = require('sequelize');
const { formatDateFR } = require('../utils/dateFormatter');
const sanitizeHtml = require('sanitize-html');
const { getLeaveRules, canManagerViewAllAbsences } = require('./politiqueConges');
const { resolveManagerDelivery, getManagerAbsenceScope } = require('./managerCrossServicePolicy');
const notificationService = require('./notificationService');
const { notifyConfiguredManagerEvent, notifyAdminsInformationEvent } = require('./managerEventNotificationService');

const VALID_ABSENCE_TYPES = ['maladie', 'absence_exceptionnelle'];

// C-2: échappement HTML pour les contenus injectés dans les templates email
function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function notifyAbsenceCreated(absence, entreprise_id, attachment = null) {
  try {
    // m-2: findAll pour notifier tous les admins actifs (findOne ne notifiait que le premier)
    const [employe, admins, entreprise, allManagers] = await Promise.all([
      Utilisateur.findByPk(absence.utilisateur_id),
      Utilisateur.findAll({ where: { entreprise_id, role: 'admin_entreprise', statut: 'actif' } }),
      Entreprise.findByPk(entreprise_id, { attributes: ['politique_conges'] }),
      Utilisateur.findAll({ where: { entreprise_id, role: 'manager', statut: 'actif' } }),
    ]);

    const rules = getLeaveRules(entreprise);
    const managers = allManagers.map(manager => ({
      manager,
      delivery: resolveManagerDelivery({
        rules, manager, targetService: employe?.service, category: absence.type_absence,
      }),
    })).filter(({ delivery }) => delivery.email || delivery.in_app);

    const typeLibelle = absence.type_absence === 'maladie' ? 'Arrêt maladie' : 'Absence exceptionnelle';
    const hasJustificatif = Boolean(absence.justificatif || absence.justificatif_metadata);
    const justificatifNom = absence.justificatif_metadata?.nom_original || absence.justificatif || '';
    const justificatifTaille = absence.justificatif_metadata?.taille_formatee || '';
    const justificatifText = justificatifNom ? `${justificatifNom}${justificatifTaille ? ` (${justificatifTaille})` : ''}` : '';

    const justificatifRowHtml = hasJustificatif
      ? `<tr>
          <td style="padding:8px 12px;background:#f9fafb;border:1px solid #e5e7eb;color:#6b7280;font-size:14px;">Justificatif</td>
          <td style="padding:8px 12px;border:1px solid #e5e7eb;">📎 ${esc(justificatifText)} <span style="color:#059669;font-size:12px;font-style:italic;">(pièce jointe incluse)</span></td>
        </tr>`
      : '';

    const base = {
      prenom: employe?.prenom || '',
      nom: employe?.nom || '',
      type_absence: absence.type_absence,
      type_absence_libelle: typeLibelle,
      date_debut: formatDateFR(absence.date_debut),
      date_fin: formatDateFR(absence.date_fin),
      commentaire: absence.commentaire,
      employe_email: employe?.email || '',
      entreprise_id,
      justificatif_row_html: justificatifRowHtml,
    };

    const recipients = [];

    if (employe?.email) {
      recipients.push(emailService.sendEmail(
        employe.email,
        'Nouvelle absence enregistrée',
        'absence-notification',
        {
          ...base,
          content: `<p>Bonjour ${esc(employe.prenom)},<br>Votre absence (${esc(typeLibelle)}) du ${formatDateFR(absence.date_debut)} au ${formatDateFR(absence.date_fin)} a bien été enregistrée.<br>Commentaire : ${esc(absence.commentaire)}${hasJustificatif ? `<br>Justificatif joint : ${esc(justificatifText)}` : ''}</p>`,
        }
      ));
    }

    for (const admin of admins) {
      if (admin.email) {
        recipients.push(emailService.sendEmail(
          admin.email,
          'Nouvelle absence déclarée',
          'absence-notification',
          {
            ...base,
            notification_mode: 'information',
            content: `<p>Nouvelle absence déclarée par ${esc(employe?.prenom)} ${esc(employe?.nom)} (${esc(employe?.email)}) du ${formatDateFR(absence.date_debut)} au ${formatDateFR(absence.date_fin)}.<br>Type : ${esc(typeLibelle)}<br>Commentaire : ${esc(absence.commentaire)}${hasJustificatif ? `<br>Justificatif joint : ${esc(justificatifText)}` : ''}</p>`,
          },
          ...(attachment ? [[attachment]] : [])
        ));
      }
      recipients.push(notificationService.creerNotification({
        entreprise_id, utilisateur_id: admin.id, type: 'absence_declaree',
        notification_mode: 'information', url: '/absences/equipe',
        message: `${employe?.prenom || ''} ${employe?.nom || ''} a déclaré une ${absence.type_absence === 'maladie' ? 'absence maladie' : 'absence exceptionnelle'} du ${formatDateFR(absence.date_debut)} au ${formatDateFR(absence.date_fin)}${hasJustificatif ? ' (avec justificatif)' : ''}.`,
      }));
    }

    for (const { manager, delivery } of managers) {
      if (delivery.email && manager.email) {
        const managerAttachments = delivery.local && attachment ? [attachment] : [];
        const managerJustificatifHtml = delivery.local ? justificatifRowHtml : '';
        recipients.push(emailService.sendEmail(
          manager.email,
          manager.service === employe?.service ? 'Nouvelle absence dans votre équipe' : 'Nouvelle absence dans un autre service',
          'absence-notification',
          {
            ...base,
            justificatif_row_html: managerJustificatifHtml,
            notification_mode: delivery.local ? undefined : 'information',
            commentaire: delivery.local ? absence.commentaire : null,
            content: `<p>Nouvelle absence déclarée par ${esc(employe?.prenom)} ${esc(employe?.nom)} (${esc(employe?.email)}) du ${formatDateFR(absence.date_debut)} au ${formatDateFR(absence.date_fin)}.<br>Type : ${esc(typeLibelle)}${delivery.local ? `<br>Commentaire : ${esc(absence.commentaire)}${hasJustificatif ? `<br>Justificatif : ${esc(justificatifText)}` : ''}` : '<br>Pour information : cette absence est enregistrée immédiatement, sans validation obligatoire.'}</p>`,
          },
          ...(managerAttachments.length > 0 ? [managerAttachments] : [])
        ));
      }
      // The previous absence emails did not create in-app alerts for local managers.
      if (!delivery.local && delivery.in_app) {
        recipients.push(notificationService.creerNotification({
          entreprise_id,
          utilisateur_id: manager.id,
          type: 'absence_declaree',
          delivery,
          message: `${employe?.prenom || ''} ${employe?.nom || ''} a déclaré une ${absence.type_absence === 'maladie' ? 'absence maladie' : 'absence exceptionnelle'} du ${formatDateFR(absence.date_debut)} au ${formatDateFR(absence.date_fin)}${hasJustificatif ? ' (avec justificatif)' : ''}.`,
          url: '/absences/equipe',
        }));
      }
    }

    const results = await Promise.allSettled(recipients);
    for (const result of results) {
      if (result.status === 'rejected') {
        logger.error('Erreur envoi email absence', { error: result.reason?.message || String(result.reason) });
      }
    }
  } catch (err) {
    logger.error('Erreur envoi email absence', { error: err.message });
  }
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

async function createAbsence({
  utilisateur_id,
  entreprise_id,
  type_absence,
  date_debut,
  date_fin,
  commentaire,
  justificatif = null,
  justificatif_metadata = null,
  attachment = null,
}) {
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

  const absence = await Absence.create({
    utilisateur_id,
    entreprise_id,
    type_absence,
    date_debut,
    date_fin,
    commentaire: safeCommentaire,
    justificatif: justificatif || null,
    justificatif_metadata: justificatif_metadata || null,
  });

  notifyAbsenceCreated(absence, entreprise_id, attachment);

  return absence;
}

// Rôles pouvant voir les données médicales d'un collègue (RGPD Art. 9)
const MEDICAL_ACCESS_ROLES = ['manager', 'admin_entreprise', 'super_admin'];

async function listAbsences({ role, id: userId, entreprise_id }, query) {
  const { type_absence, date_debut, date_fin } = query;
  if (type_absence && !VALID_ABSENCE_TYPES.includes(type_absence)) {
    throw Object.assign(new Error('Type d’absence invalide.'), { status: 400 });
  }
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

  if (role === 'manager') {
    const [manager, entreprise] = await Promise.all([
      Utilisateur.findByPk(userId, { attributes: ['id', 'service'] }),
      Entreprise.findByPk(entreprise_id, { attributes: ['politique_conges'] }),
    ]);
    const rules = getLeaveRules(entreprise);
    if (!canManagerViewAllAbsences(rules, manager)) {
      const visibleUsers = await Utilisateur.findAll({
        where: { entreprise_id, ...(manager?.service ? { service: manager.service } : { id: userId }) },
        attributes: ['id'],
        raw: true,
      });
      const visibleIds = [...new Set([...visibleUsers.map(user => user.id), userId])];
      if (utilisateur_id_filter && !visibleIds.includes(utilisateur_id_filter)
        && (type_absence ? !canManagerViewAllAbsences(rules, manager, type_absence)
          : !['maladie', 'absence_exceptionnelle'].some(type => canManagerViewAllAbsences(rules, manager, type)))) {
        throw Object.assign(new Error('Vous ne pouvez pas consulter les absences des autres services.'), { status: 403 });
      }
      Object.assign(where, getManagerAbsenceScope(rules, manager, visibleIds));
    }
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
      plain.justificatif = null;
      plain.justificatif_metadata = null;
      return plain;
    }
    return absence;
  });
}

async function assertManagerAbsenceAction(user, utilisateurId, type) {
  if (user.role !== 'manager' || user.id === utilisateurId) return;
  if (!VALID_ABSENCE_TYPES.includes(type)) {
    throw Object.assign(new Error('Type d’absence invalide.'), { status: 400 });
  }
  const [manager, employee, entreprise] = await Promise.all([
    Utilisateur.findByPk(user.id, { attributes: ['id', 'service'] }),
    Utilisateur.findByPk(utilisateurId, { attributes: ['id', 'service', 'entreprise_id'] }),
    Entreprise.findByPk(user.entreprise_id, { attributes: ['politique_conges'] }),
  ]);
  if (employee?.entreprise_id === user.entreprise_id && manager
    && !manager.service && !employee.service) return;
  if (!employee || employee.entreprise_id !== user.entreprise_id
    || !resolveManagerDelivery({
      rules: getLeaveRules(entreprise), manager, targetService: employee.service, category: type,
    }).canAct) {
    throw Object.assign(new Error('Vous ne pouvez pas agir sur les absences des autres services.'), { status: 403 });
  }
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
  await assertManagerAbsenceAction(user, absence.utilisateur_id, absence.type_absence);

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

  await sequelize.transaction(async transaction => {
    await absence.destroy({ transaction });
    const employee = await Utilisateur.findByPk(absence.utilisateur_id, {
      attributes: ['id', 'prenom', 'nom', 'service'], transaction,
    });
    await notifyConfiguredManagerEvent({
      entrepriseId: absence.entreprise_id, service: employee?.service, category: absence.type_absence,
      type: 'absence_supprimee',
      message: `L’absence ${absence.type_absence === 'maladie' ? 'maladie' : 'exceptionnelle'} de ${employee?.prenom || ''} ${employee?.nom || ''} du ${formatDateFR(absence.date_debut)} au ${formatDateFR(absence.date_fin)} a été supprimée.`,
      url: '/absences/equipe', excludeUserIds: [user.id, absence.utilisateur_id], transaction,
    });
    await notifyAdminsInformationEvent({
      entrepriseId: absence.entreprise_id, type: 'absence_supprimee',
      message: `L’absence ${absence.type_absence === 'maladie' ? 'maladie' : 'exceptionnelle'} de ${employee?.prenom || ''} ${employee?.nom || ''} du ${formatDateFR(absence.date_debut)} au ${formatDateFR(absence.date_fin)} a été supprimée.`,
      url: '/absences/equipe', excludeUserIds: [user.id, absence.utilisateur_id], transaction,
    });
  });
}

module.exports = { createAbsence, listAbsences, notifyAbsenceCreated, deleteAbsence, assertManagerAbsenceAction };
