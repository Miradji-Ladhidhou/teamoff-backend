'use strict';

const { CongeActionRequest, Conge, Utilisateur, CongeType, Entreprise, sequelize } = require('../models');
const { Op } = require('sequelize');
const congesService = require('./congesService');
const notificationService = require('./notificationService');
const { formatDateFR } = require('../utils/dateFormatter');
const logger = require('../utils/logger');

const FRONTEND_URL = (process.env.FRONTEND_URL || 'http://localhost:3001').split(',')[0].trim();

// Workflows qui autorisent le manager à traiter les demandes d'action
const MANAGER_ALLOWED_WORKFLOWS = ['manager_only', 'manager', 'manager_admin'];

function fireEmail(params) {
  notificationService.sendEmail(params).catch(err =>
    logger.error('congeActionRequestService email error', { error: err.message })
  );
}

function buildCongeUrl(congeId) {
  return `${FRONTEND_URL}/conges/${congeId}`;
}

function buildRequestsUrl() {
  return `${FRONTEND_URL}/conges/demandes`;
}

function typeLabel(type) {
  return type === 'cancel' ? 'annulation' : 'modification';
}

function deAction(action) {
  return /^[aeiouàâéèêëîïôùûüœ]/i.test(action) ? `d'${action}` : `de ${action}`;
}

function laAction(action) {
  return /^[aeiouàâéèêëîïôùûüœ]/i.test(action) ? `l'${action}` : `la ${action}`;
}

function nouvellePeriodeRow(req) {
  if (req.type !== 'modify' || !req.date_debut_demandee) return '';
  return `<tr><td style="padding:8px 12px;background:#f9fafb;border:1px solid #e5e7eb;color:#6b7280;font-size:14px;">Nouvelle période demandée</td>
      <td style="padding:8px 12px;border:1px solid #e5e7eb;font-weight:600;">${formatDateFR(req.date_debut_demandee)} au ${formatDateFR(req.date_fin_demandee)}</td></tr>`;
}

// ---------------------------------------------------------------------------
// Soumettre une demande (employé/manager)
// ---------------------------------------------------------------------------
async function submitRequest({ congeId, type, commentaire, date_debut_demandee, date_fin_demandee, debut_demi_journee_demandee, fin_demi_journee_demandee, user }) {
  if (!['cancel', 'modify'].includes(type)) {
    const err = new Error('Type invalide (cancel ou modify)'); err.statusCode = 400; throw err;
  }
  if (!commentaire?.trim()) {
    const err = new Error('Le motif est obligatoire'); err.statusCode = 400; throw err;
  }
  if (commentaire.trim().length > 5000) {
    const err = new Error('Le commentaire ne peut pas dépasser 5000 caractères'); err.statusCode = 400; throw err;
  }
  if (type === 'modify' && (!date_debut_demandee || !date_fin_demandee)) {
    const err = new Error('Les nouvelles dates sont obligatoires pour une modification'); err.statusCode = 400; throw err;
  }
  const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  if (type === 'modify') {
    if (!ISO_DATE_RE.test(date_debut_demandee) || !ISO_DATE_RE.test(date_fin_demandee)) {
      const err = new Error('Format de date invalide (YYYY-MM-DD attendu)'); err.statusCode = 400; throw err;
    }
    if (date_fin_demandee < date_debut_demandee) {
      const err = new Error('La date de fin ne peut pas être antérieure à la date de début'); err.statusCode = 400; throw err;
    }
  }

  const conge = await Conge.findByPk(congeId, {
    include: [{ model: CongeType, as: 'conge_type' }],
  });
  if (!conge) { const err = new Error('Congé introuvable'); err.statusCode = 404; throw err; }
  if (conge.utilisateur_id !== user.id) {
    const err = new Error('Accès interdit'); err.statusCode = 403; throw err;
  }
  if (!['valide_final', 'valide_manager'].includes(conge.statut)) {
    const err = new Error('Seuls les conges valides peuvent faire l\'objet d\'une demande'); err.statusCode = 400; throw err;
  }

  // Vérifier la politique
  const LeavePolicyService = require('./leavePolicyService');
  const validator = type === 'cancel' ? 'validateCancellation' : 'validateModification';
  // Pour modify : le préavis s'applique aux NOUVELLES dates (pas aux dates actuelles du congé)
  const policyStartDate = type === 'modify' && date_debut_demandee ? date_debut_demandee : conge.date_debut;
  const policyResult = await LeavePolicyService[validator]({
    entrepriseId: conge.entreprise_id,
    congeStatus: conge.statut,
    congeStartDate: policyStartDate,
    initiatorRole: user.role,
  });
  if (!policyResult?.allowed) {
    const err = new Error(policyResult?.reason || 'Non autorisé selon la politique'); err.statusCode = 403; throw err;
  }

  // Pour une modification : vérifier que les nouvelles dates contiennent au moins un jour ouvré
  if (type === 'modify') {
    const newDays = await congesService.calcJoursConges(conge.entreprise_id, date_debut_demandee, date_fin_demandee, debut_demi_journee_demandee || 'matin', fin_demi_journee_demandee || 'apres_midi');
    if (!Number.isFinite(newDays) || newDays <= 0) {
      const err = new Error('La nouvelle période ne contient aucun jour ouvré. Vérifiez les dates (week-ends, jours fériés ou jours bloqués).');
      err.statusCode = 400; throw err;
    }

    // Vérifier chevauchement avec d'autres congés (exclut le congé en cours de modification)
    const overlappingConge = await Conge.findOne({
      where: {
        utilisateur_id: conge.utilisateur_id,
        id: { [Op.ne]: congeId },
        statut: { [Op.in]: ['reserve', 'en_attente_manager', 'valide_manager', 'valide_final'] },
        date_debut: { [Op.lte]: date_fin_demandee },
        date_fin: { [Op.gte]: date_debut_demandee },
      },
    });
    if (overlappingConge) {
      const { formatDateFR: fmt } = require('../utils/dateFormatter');
      const err = new Error(`Ces dates chevauchent un autre congé existant (${fmt(overlappingConge.date_debut)} → ${fmt(overlappingConge.date_fin)}).`);
      err.statusCode = 409; throw err;
    }
  }

  // Bloquer si une demande pending existe déjà pour ce congé
  const existing = await CongeActionRequest.findOne({
    where: { conge_id: congeId, statut: 'pending' },
  });
  if (existing) {
    const err = new Error('Une demande est déjà en attente pour ce congé'); err.statusCode = 409; throw err;
  }

  const request = await CongeActionRequest.create({
    conge_id: congeId,
    entreprise_id: conge.entreprise_id,
    utilisateur_id: user.id,
    type,
    statut: 'pending',
    conge_date_debut_origine: conge.date_debut,
    conge_date_fin_origine:   conge.date_fin,
    date_debut_demandee:         date_debut_demandee || null,
    date_fin_demandee:           date_fin_demandee || null,
    debut_demi_journee_demandee: debut_demi_journee_demandee || null,
    fin_demi_journee_demandee:   fin_demi_journee_demandee || null,
    commentaire_employe: commentaire.trim(),
  });

  // Charger les acteurs
  const employe = await Utilisateur.findByPk(user.id, { attributes: ['id', 'prenom', 'nom', 'email', 'service'] });
  const adminsEntreprise = await Utilisateur.findAll({ where: { entreprise_id: conge.entreprise_id, role: 'admin_entreprise', statut: 'actif' } });

  // Utiliser le workflow figé au moment de la création du congé
  const effectiveWorkflow = conge.effective_approval_workflow;
  const managerCanAct = MANAGER_ALLOWED_WORKFLOWS.includes(effectiveWorkflow);

  const employe_nom = `${employe.prenom || ''} ${employe.nom || ''}`.trim() || 'Collaborateur';
  const action = typeLabel(type);
  const npRow = nouvellePeriodeRow(request);

  // Email à l'employé — confirmation
  if (employe?.email) {
    fireEmail({
      to: employe.email,
      subject: `Demande ${deAction(action)} soumise — en attente de validation`,
      templateName: 'leave-action-request-employee',
      data: {
        destinataire_prenom: employe.prenom || 'Collaborateur',
        type_action: action,
        type_conge: conge.conge_type?.libelle || 'Congé',
        date_debut: formatDateFR(conge.date_debut),
        date_fin: formatDateFR(conge.date_fin),
        nouvelle_periode_row: npRow,
        commentaire_employe: request.commentaire_employe,
        action_url: buildCongeUrl(congeId),
      }
    });
  }

  // Email à tous les admins — action requise (toujours notifiés, rôle variable selon workflow)
  const adminActionRequired = !managerCanAct || effectiveWorkflow === 'manager_admin';
  for (const adminUser of adminsEntreprise) {
    if (adminUser.email) {
      fireEmail({
        to: adminUser.email,
        subject: adminActionRequired
          ? `Action requise — demande ${deAction(action)} de congé validé`
          : `Pour information — demande ${deAction(action)} de congé`,
        templateName: 'leave-action-request-admin',
        data: {
          destinataire_prenom: adminUser.prenom || 'Administrateur',
          titre_email: adminActionRequired
            ? `Demande ${deAction(action)} — action requise`
            : `Demande ${deAction(action)} — pour information`,
          sous_titre: adminActionRequired
            ? 'Vous devez approuver ou refuser cette demande'
            : 'Cette demande sera traitée par le manager',
          message_role: adminActionRequired
            ? 'Veuillez examiner et traiter cette demande depuis votre espace administrateur.'
            : 'Le manager de l\'employé est en charge du traitement de cette demande.',
          demandeur_nom: employe_nom,
          type_action: action,
          type_conge: conge.conge_type?.libelle || 'Congé',
          date_debut: formatDateFR(conge.date_debut),
          date_fin: formatDateFR(conge.date_fin),
          nouvelle_periode_row: npRow,
          commentaire_employe: request.commentaire_employe,
          bouton_action: adminActionRequired
            ? `<p><a href="${buildRequestsUrl()}" style="display:inline-block;background:#dc2626;color:#fff;text-decoration:none;padding:12px 18px;border-radius:8px;font-weight:bold;">Traiter la demande</a></p>`
            : `<p><a href="${buildCongeUrl(congeId)}" style="display:inline-block;background:#6b7280;color:#fff;text-decoration:none;padding:12px 18px;border-radius:8px;font-weight:bold;">Voir le congé</a></p>`,
        }
      });
      if (adminActionRequired) {
        await notificationService.creerNotification({
          entreprise_id: conge.entreprise_id,
          utilisateur_id: adminUser.id,
          type: 'conge_action_request',
          message: `${employe_nom} demande ${laAction(action)} de son congé du ${formatDateFR(conge.date_debut)} au ${formatDateFR(conge.date_fin)}`,
          url: '/conges/demandes',
        });
      }
    }
  }

  // Email aux managers — action requise ou pour information selon workflow
  if (managerCanAct) {
    const managers = await Utilisateur.findAll({ where: { entreprise_id: conge.entreprise_id, role: 'manager', statut: 'actif' } });
    for (const mgr of managers) {
      if (mgr.email) {
        fireEmail({
          to: mgr.email,
          subject: `Action requise — demande ${deAction(action)} de congé validé`,
          templateName: 'leave-action-request-admin',
          data: {
            destinataire_prenom: mgr.prenom || 'Manager',
            titre_email: `Demande ${deAction(action)} — action requise`,
            sous_titre: 'Vous devez approuver ou refuser cette demande',
            message_role: 'Veuillez examiner et traiter cette demande depuis votre espace.',
            demandeur_nom: employe_nom,
            type_action: action,
            type_conge: conge.conge_type?.libelle || 'Congé',
            date_debut: formatDateFR(conge.date_debut),
            date_fin: formatDateFR(conge.date_fin),
            nouvelle_periode_row: npRow,
            commentaire_employe: request.commentaire_employe,
            bouton_action: `<p><a href="${buildRequestsUrl()}" style="display:inline-block;background:#dc2626;color:#fff;text-decoration:none;padding:12px 18px;border-radius:8px;font-weight:bold;">Traiter la demande</a></p>`,
          }
        });
      }
      await notificationService.creerNotification({
        entreprise_id: conge.entreprise_id,
        utilisateur_id: mgr.id,
        type: 'conge_action_request',
        message: `${employe_nom} demande ${laAction(action)} de son congé du ${formatDateFR(conge.date_debut)} au ${formatDateFR(conge.date_fin)}`,
        url: '/conges/demandes',
      });
    }
  }

  return request;
}

// ---------------------------------------------------------------------------
// Lister les demandes (admin + manager)
// ---------------------------------------------------------------------------
async function listRequests({ entrepriseId, statut, page = 1, limit = 20 }) {
  const where = { entreprise_id: entrepriseId };
  if (statut) where.statut = statut;

  const offset = (page - 1) * limit;
  const { rows, count } = await CongeActionRequest.findAndCountAll({
    where,
    include: [
      {
        model: Conge,
        as: 'conge',
        include: [{ model: CongeType, as: 'conge_type', attributes: ['id', 'libelle'] }],
      },
      { model: Utilisateur, as: 'utilisateur', attributes: ['id', 'prenom', 'nom', 'email', 'service'] },
    ],
    order: [['created_at', 'DESC']],
    limit,
    offset,
  });

  return { requests: rows, total: count, totalPages: Math.ceil(count / limit) };
}

// ---------------------------------------------------------------------------
// Obtenir une demande (admin + manager)
// ---------------------------------------------------------------------------
async function getRequest(requestId, entrepriseId) {
  const req = await CongeActionRequest.findOne({
    where: { id: requestId, entreprise_id: entrepriseId },
    include: [
      {
        model: Conge,
        as: 'conge',
        include: [{ model: CongeType, as: 'conge_type' }],
      },
      { model: Utilisateur, as: 'utilisateur', attributes: ['id', 'prenom', 'nom', 'email', 'service'] },
    ],
  });
  if (!req) { const err = new Error('Demande introuvable'); err.statusCode = 404; throw err; }
  return req;
}

// ---------------------------------------------------------------------------
// Approuver (admin ou manager selon workflow)
// ---------------------------------------------------------------------------
async function approveRequest(requestId, { commentaire, adminUser }) {
  const actingUser = adminUser; // paramètre conservé pour compat

  const request = await CongeActionRequest.findOne({
    where: { id: requestId, entreprise_id: actingUser.entreprise_id, statut: 'pending' },
    include: [
      { model: Conge, as: 'conge', include: [{ model: CongeType, as: 'conge_type' }] },
      { model: Utilisateur, as: 'utilisateur', attributes: ['id', 'prenom', 'nom', 'email', 'service'] },
    ],
  });
  if (!request) { const err = new Error('Demande introuvable ou déjà traitée'); err.statusCode = 404; throw err; }

  const conge = request.conge;
  if (!conge) {
    const err = new Error('Le congé associé à cette demande n\'existe plus'); err.statusCode = 422; throw err;
  }

  // Vérifier que le manager est autorisé par le workflow figé
  // null = congé créé avant l'introduction du champ → on autorise par défaut (fallback permissif)
  if (actingUser.role === 'manager') {
    const effectiveWorkflow = conge?.effective_approval_workflow;
    if (effectiveWorkflow && !MANAGER_ALLOWED_WORKFLOWS.includes(effectiveWorkflow)) {
      const err = new Error('Le workflow de ce congé ne permet pas au manager de traiter cette demande');
      err.statusCode = 403; throw err;
    }
  }

  const employe = request.utilisateur;
  const employe_nom = `${employe.prenom || ''} ${employe.nom || ''}`.trim();
  const action = typeLabel(request.type);

  // Exécuter l'action réelle
  if (request.type === 'cancel') {
    await congesService.deleteConge(conge.id, actingUser, {
      commentaire: commentaire || request.commentaire_employe || 'Annulation approuvée',
    });
  } else {
    // Pré-vérification des jours ouvrés pour un message d'erreur précis
    const previewDays = await congesService.calcJoursConges(
      conge.entreprise_id,
      request.date_debut_demandee,
      request.date_fin_demandee,
      request.debut_demi_journee_demandee || 'matin',
      request.fin_demi_journee_demandee || 'apres_midi'
    );
    if (!Number.isFinite(previewDays) || previewDays <= 0) {
      const debut = formatDateFR(request.date_debut_demandee);
      const fin = formatDateFR(request.date_fin_demandee);
      const err = new Error(
        `Les nouvelles dates demandées (${debut} → ${fin}) ne contiennent aucun jour ouvré. ` +
        `Ces dates tombent probablement sur des week-ends, jours fériés ou jours bloqués par la politique de l'entreprise. ` +
        `Refusez cette demande et invitez l'employé à soumettre de nouvelles dates valides.`
      );
      err.statusCode = 422; throw err;
    }

    try {
      await congesService.updateConge(conge.id, {
        date_debut: request.date_debut_demandee,
        date_fin: request.date_fin_demandee,
        debut_demi_journee: request.debut_demi_journee_demandee || 'matin',
        fin_demi_journee: request.fin_demi_journee_demandee || 'apres_midi',
      }, actingUser);
    } catch (err) {
      // Enrichir le message pour les erreurs de validation sans statusCode
      if (!err.statusCode) {
        const enriched = new Error(`Impossible d'approuver la modification : ${err.message}`);
        enriched.statusCode = 422; throw enriched;
      }
      throw err;
    }
  }

  // Marquer la demande comme approuvée
  await request.update({ statut: 'approved', commentaire_admin: commentaire || null });

  const actingNom = `${actingUser.prenom || ''} ${actingUser.nom || ''}`.trim() || (actingUser.role === 'manager' ? 'Le manager' : "L'administrateur");
  const npRow = nouvellePeriodeRow(request);
  const isManager = actingUser.role === 'manager';

  // Construire les lignes de détail
  let detailRows = '';
  if (request.type === 'cancel') {
    detailRows = `<tr><td style="padding:8px 12px;background:#f9fafb;border:1px solid #e5e7eb;color:#6b7280;font-size:14px;">Période annulée</td>
      <td style="padding:8px 12px;border:1px solid #e5e7eb;font-weight:600;">${formatDateFR(conge.date_debut)} au ${formatDateFR(conge.date_fin)}</td></tr>`;
  } else {
    detailRows = `<tr><td style="padding:8px 12px;background:#f9fafb;border:1px solid #e5e7eb;color:#6b7280;font-size:14px;">Ancienne période</td>
      <td style="padding:8px 12px;border:1px solid #e5e7eb;font-style:italic;color:#6b7280;">${formatDateFR(conge.date_debut)} au ${formatDateFR(conge.date_fin)}</td></tr>
      <tr><td style="padding:8px 12px;background:#f9fafb;border:1px solid #e5e7eb;color:#6b7280;font-size:14px;">Nouvelle période</td>
      <td style="padding:8px 12px;border:1px solid #e5e7eb;font-weight:600;">${formatDateFR(request.date_debut_demandee)} au ${formatDateFR(request.date_fin_demandee)}</td></tr>`;
  }

  const employeMessage = request.type === 'cancel'
    ? `Votre demande d'annulation a été approuvée par <strong>${actingNom}</strong>. Votre congé a été annulé et votre solde recalculé.`
    : `Votre demande de modification a été approuvée par <strong>${actingNom}</strong>.`;

  // Email à l'employé
  if (employe?.email) {
    fireEmail({
      to: employe.email,
      subject: `Demande ${deAction(action)} approuvée`,
      templateName: 'leave-action-approved',
      data: {
        destinataire_prenom: employe.prenom || 'Collaborateur',
        type_action: action,
        type_conge: conge.conge_type?.libelle || 'Congé',
        employe_nom,
        message_principal: employeMessage,
        detail_rows: detailRows,
        commentaire_admin: commentaire || 'Aucun',
        action_url: buildCongeUrl(conge.id),
      }
    });
    await notificationService.creerNotification({
      entreprise_id: conge.entreprise_id,
      utilisateur_id: employe.id,
      type: 'conge_action_approved',
      message: `Votre demande ${deAction(action)} a été approuvée par ${actingNom}`,
      url: `/conges/${conge.id}`,
    });
  }

  // Si c'est le manager qui a agi → notifier tous les admins pour information
  if (isManager) {
    const adminsApprove = await Utilisateur.findAll({ where: { entreprise_id: conge.entreprise_id, role: 'admin_entreprise', statut: 'actif' } });
    for (const adminUser of adminsApprove) {
      if (adminUser.email) {
        const adminMessage = request.type === 'cancel'
          ? `La demande d'annulation de <strong>${employe_nom}</strong> a été approuvée par le manager <strong>${actingNom}</strong>. Le congé a été supprimé.`
          : `La demande de modification de <strong>${employe_nom}</strong> a été approuvée par le manager <strong>${actingNom}</strong>.`;
        fireEmail({
          to: adminUser.email,
          subject: `Pour information — demande ${deAction(action)} approuvée par le manager`,
          templateName: 'leave-action-approved',
          data: {
            destinataire_prenom: adminUser.prenom || 'Administrateur',
            type_action: action,
            type_conge: conge.conge_type?.libelle || 'Congé',
            employe_nom,
            message_principal: adminMessage,
            detail_rows: detailRows,
            commentaire_admin: commentaire || 'Aucun',
            action_url: buildCongeUrl(conge.id),
          }
        });
      }
    }
  } else {
    // Admin a agi → notifier les managers pour information (si workflow les implique ou inconnu)
    const effectiveWorkflow = conge?.effective_approval_workflow;
    // null = congé créé avant que le champ existe → on notifie par défaut (plus sûr)
    if (!effectiveWorkflow || MANAGER_ALLOWED_WORKFLOWS.includes(effectiveWorkflow)) {
      const managers = await Utilisateur.findAll({ where: { entreprise_id: conge.entreprise_id, role: 'manager', statut: 'actif' } });
      for (const mgr of managers) {
        if (mgr.email) {
          const managerMessage = request.type === 'cancel'
            ? `La demande d'annulation de <strong>${employe_nom}</strong> a été approuvée par ${actingNom}. Le congé a été supprimé.`
            : `La demande de modification de <strong>${employe_nom}</strong> a été approuvée par ${actingNom}.`;
          fireEmail({
            to: mgr.email,
            subject: `Pour information — demande ${deAction(action)} approuvée`,
            templateName: 'leave-action-approved',
            data: {
              destinataire_prenom: mgr.prenom || 'Manager',
              type_action: action,
              type_conge: conge.conge_type?.libelle || 'Congé',
              employe_nom,
              message_principal: managerMessage,
              detail_rows: detailRows,
              commentaire_admin: commentaire || 'Aucun',
              action_url: buildCongeUrl(conge.id),
            }
          });
          await notificationService.creerNotification({
            entreprise_id: conge.entreprise_id,
            utilisateur_id: mgr.id,
            type: 'conge_action_approved',
            message: `Demande ${deAction(action)} de ${employe_nom} approuvée par ${actingNom}`,
            url: `/conges/${conge.id}`,
          });
        }
      }
    }
  }

  return request;
}

// ---------------------------------------------------------------------------
// Refuser (admin ou manager selon workflow)
// ---------------------------------------------------------------------------
async function rejectRequest(requestId, { commentaire, adminUser }) {
  const actingUser = adminUser; // paramètre conservé pour compat
  if (!commentaire?.trim()) {
    const err = new Error('Le motif du refus est obligatoire'); err.statusCode = 400; throw err;
  }

  const request = await CongeActionRequest.findOne({
    where: { id: requestId, entreprise_id: actingUser.entreprise_id, statut: 'pending' },
    include: [
      { model: Conge, as: 'conge', include: [{ model: CongeType, as: 'conge_type' }] },
      { model: Utilisateur, as: 'utilisateur', attributes: ['id', 'prenom', 'nom', 'email'] },
    ],
  });
  if (!request) { const err = new Error('Demande introuvable ou déjà traitée'); err.statusCode = 404; throw err; }

  const conge = request.conge;
  if (!conge) {
    const err = new Error('Le congé associé à cette demande n\'existe plus'); err.statusCode = 422; throw err;
  }

  // Vérifier que le manager est autorisé par le workflow figé
  // null = congé créé avant l'introduction du champ → on autorise par défaut (fallback permissif)
  if (actingUser.role === 'manager') {
    const effectiveWorkflow = conge?.effective_approval_workflow;
    if (effectiveWorkflow && !MANAGER_ALLOWED_WORKFLOWS.includes(effectiveWorkflow)) {
      const err = new Error('Le workflow de ce congé ne permet pas au manager de traiter cette demande');
      err.statusCode = 403; throw err;
    }
  }

  await request.update({ statut: 'rejected', commentaire_admin: commentaire.trim() });

  const employe = request.utilisateur;
  const action = typeLabel(request.type);
  const employe_nom = `${employe?.prenom || ''} ${employe?.nom || ''}`.trim() || 'Un employé';
  const actingNom = `${actingUser.prenom || ''} ${actingUser.nom || ''}`.trim() || (actingUser.role === 'manager' ? 'Le manager' : "L'administrateur");
  const isManager = actingUser.role === 'manager';

  const employeMessage = request.type === 'cancel'
    ? `Votre demande d'annulation a été refusée par <strong>${actingNom}</strong>. Votre congé reste inchangé.`
    : `Votre demande de modification a été refusée par <strong>${actingNom}</strong>. Votre congé reste inchangé.`;

  if (employe?.email) {
    fireEmail({
      to: employe.email,
      subject: `Demande ${deAction(action)} refusée`,
      templateName: 'leave-action-rejected',
      data: {
        destinataire_prenom: employe.prenom || 'Collaborateur',
        type_action: action,
        type_conge: conge.conge_type?.libelle || 'Congé',
        employe_nom,
        message_principal: employeMessage,
        date_debut: formatDateFR(conge.date_debut),
        date_fin: formatDateFR(conge.date_fin),
        commentaire_admin: commentaire.trim(),
        action_url: buildCongeUrl(conge.id),
      }
    });
    await notificationService.creerNotification({
      entreprise_id: conge.entreprise_id,
      utilisateur_id: employe.id,
      type: 'conge_action_rejected',
      message: `Votre demande ${deAction(action)} a été refusée`,
      url: `/conges/${conge.id}`,
    });
  }

  // Si c'est le manager qui a agi → notifier tous les admins pour information
  if (isManager) {
    const adminsReject = await Utilisateur.findAll({ where: { entreprise_id: conge.entreprise_id, role: 'admin_entreprise', statut: 'actif' } });
    for (const adminUser of adminsReject) {
      if (adminUser.email) {
        const adminMessage = request.type === 'cancel'
          ? `La demande d'annulation de <strong>${employe_nom}</strong> a été refusée par le manager <strong>${actingNom}</strong>. Le congé reste inchangé.`
          : `La demande de modification de <strong>${employe_nom}</strong> a été refusée par le manager <strong>${actingNom}</strong>. Le congé reste inchangé.`;
        fireEmail({
          to: adminUser.email,
          subject: `Pour information — demande ${deAction(action)} refusée par le manager`,
          templateName: 'leave-action-rejected',
          data: {
            destinataire_prenom: adminUser.prenom || 'Administrateur',
            type_action: action,
            type_conge: conge.conge_type?.libelle || 'Congé',
            employe_nom,
            message_principal: adminMessage,
            date_debut: formatDateFR(conge.date_debut),
            date_fin: formatDateFR(conge.date_fin),
            commentaire_admin: commentaire.trim(),
            action_url: buildCongeUrl(conge.id),
          }
        });
      }
    }
  } else {
    // Admin a agi → notifier les managers pour information (si workflow les implique ou inconnu)
    const effectiveWorkflow = conge?.effective_approval_workflow;
    // null = congé créé avant que le champ existe → on notifie par défaut (plus sûr)
    if (!effectiveWorkflow || MANAGER_ALLOWED_WORKFLOWS.includes(effectiveWorkflow)) {
      const managers = await Utilisateur.findAll({ where: { entreprise_id: conge.entreprise_id, role: 'manager', statut: 'actif' } });
      for (const mgr of managers) {
        if (mgr.email) {
          const managerMessage = request.type === 'cancel'
            ? `La demande d'annulation de <strong>${employe_nom}</strong> a été refusée par ${actingNom}. Le congé reste inchangé.`
            : `La demande de modification de <strong>${employe_nom}</strong> a été refusée par ${actingNom}. Le congé reste inchangé.`;
          fireEmail({
            to: mgr.email,
            subject: `Pour information — demande ${deAction(action)} refusée`,
            templateName: 'leave-action-rejected',
            data: {
              destinataire_prenom: mgr.prenom || 'Manager',
              type_action: action,
              type_conge: conge.conge_type?.libelle || 'Congé',
              employe_nom,
              message_principal: managerMessage,
              date_debut: formatDateFR(conge.date_debut),
              date_fin: formatDateFR(conge.date_fin),
              commentaire_admin: commentaire.trim(),
              action_url: buildCongeUrl(conge.id),
            }
          });
          await notificationService.creerNotification({
            entreprise_id: conge.entreprise_id,
            utilisateur_id: mgr.id,
            type: 'conge_action_rejected',
            message: `Demande d'${action} de ${employe_nom} refusée par ${actingNom}`,
            url: `/conges/${conge.id}`,
          });
        }
      }
    }
  }

  return request;
}

module.exports = { submitRequest, listRequests, getRequest, approveRequest, rejectRequest };
