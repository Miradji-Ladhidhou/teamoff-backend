'use strict';

const { CongeActionRequest, Conge, Utilisateur, CongeType, Entreprise, sequelize } = require('../models');
const { getLeaveRules, getEffectiveLeaveRules } = require('./politiqueConges');

async function getEntrepriseLeaveRules(entrepriseId) {
  const entreprise = await Entreprise.findByPk(entrepriseId, { attributes: ['id', 'politique_conges'] });
  return getLeaveRules(entreprise || {});
}
const LeavePolicyService = require('./leavePolicyService');
const congesService = require('./congesService');
const notificationService = require('./notificationService');
const { formatDateFR } = require('../utils/dateFormatter');
const logger = require('../utils/logger');

const FRONTEND_URL = (process.env.FRONTEND_URL || 'http://localhost:3001').split(',')[0].trim();

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

function nouvellePeriodeRow(req) {
  if (req.type !== 'modify' || !req.date_debut_demandee) return '';
  return `<tr><td style="padding:8px 12px;background:#f9fafb;border:1px solid #e5e7eb;color:#6b7280;font-size:14px;">Nouvelle periode demandee</td>
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
  if (type === 'modify' && (!date_debut_demandee || !date_fin_demandee)) {
    const err = new Error('Les nouvelles dates sont obligatoires pour une modification'); err.statusCode = 400; throw err;
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
  const validator = type === 'cancel' ? 'validateCancellation' : 'validateModification';
  const policyResult = await LeavePolicyService[validator]({
    entrepriseId: conge.entreprise_id,
    congeStatus: conge.statut,
    congeStartDate: conge.date_debut,
    initiatorRole: user.role,
  });
  if (!policyResult?.allowed) {
    const err = new Error(policyResult?.reason || 'Non autorisé selon la politique'); err.statusCode = 403; throw err;
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
    date_debut_demandee:         date_debut_demandee || null,
    date_fin_demandee:           date_fin_demandee || null,
    debut_demi_journee_demandee: debut_demi_journee_demandee || null,
    fin_demi_journee_demandee:   fin_demi_journee_demandee || null,
    commentaire_employe: commentaire.trim(),
  });

  // Charger les acteurs
  const employe = await Utilisateur.findByPk(user.id, { attributes: ['id', 'prenom', 'nom', 'email'] });
  const adminUser = await Utilisateur.findOne({ where: { entreprise_id: conge.entreprise_id, role: 'admin_entreprise', statut: 'actif' } });
  const baseRules = await getEntrepriseLeaveRules(conge.entreprise_id);
  const leaveRules = getEffectiveLeaveRules(baseRules, employe?.service || null);

  const employe_nom = `${employe.prenom || ''} ${employe.nom || ''}`.trim() || 'Collaborateur';
  const action = typeLabel(type);
  const npRow = nouvellePeriodeRow(request);

  // Email à l'employé — confirmation
  if (employe?.email) {
    fireEmail({
      to: employe.email,
      subject: `Demande d'${action} soumise - en attente de validation`,
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

  // Email à l'admin — action requise
  if (adminUser?.email) {
    fireEmail({
      to: adminUser.email,
      subject: `Action requise - demande d'${action} de congé validé`,
      templateName: 'leave-action-request-admin',
      data: {
        destinataire_prenom: adminUser.prenom || 'Administrateur',
        titre_email: `Demande d'${action} - action requise`,
        sous_titre: 'Vous devez approuver ou refuser cette demande',
        message_role: 'Veuillez examiner et traiter cette demande depuis votre espace administrateur.',
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
    await notificationService.creerNotification({
      entreprise_id: conge.entreprise_id,
      utilisateur_id: adminUser.id,
      type: 'conge_action_request',
      message: `${employe_nom} demande l'${action} de son congé du ${formatDateFR(conge.date_debut)} au ${formatDateFR(conge.date_fin)}`,
      url: '/conges/demandes',
    });
  }

  // Email aux managers — pour information (selon workflow)
  const workflowNeedsManager = ['manager_only', 'manager', 'manager_admin'].includes(leaveRules.approval_workflow);
  if (workflowNeedsManager) {
    const managers = await Utilisateur.findAll({ where: { entreprise_id: conge.entreprise_id, role: 'manager', statut: 'actif' } });
    for (const mgr of managers) {
      if (mgr.email) {
        fireEmail({
          to: mgr.email,
          subject: `Pour information - demande d'${action} de congé`,
          templateName: 'leave-action-request-admin',
          data: {
            destinataire_prenom: mgr.prenom || 'Manager',
            titre_email: `Demande d'${action} - pour information`,
            sous_titre: 'Aucune action requise de votre part',
            message_role: 'Cette demande sera traitee par l\'administrateur.',
            demandeur_nom: employe_nom,
            type_action: action,
            type_conge: conge.conge_type?.libelle || 'Congé',
            date_debut: formatDateFR(conge.date_debut),
            date_fin: formatDateFR(conge.date_fin),
            nouvelle_periode_row: npRow,
            commentaire_employe: request.commentaire_employe,
            bouton_action: `<p><a href="${buildCongeUrl(congeId)}" style="display:inline-block;background:#6b7280;color:#fff;text-decoration:none;padding:12px 18px;border-radius:8px;font-weight:bold;">Voir le conge</a></p>`,
          }
        });
      }
      await notificationService.creerNotification({
        entreprise_id: conge.entreprise_id,
        utilisateur_id: mgr.id,
        type: 'conge_action_request',
        message: `${employe_nom} demande l'${action} de son congé du ${formatDateFR(conge.date_debut)} au ${formatDateFR(conge.date_fin)}`,
        url: `/conges/${congeId}`,
      });
    }
  }

  return request;
}

// ---------------------------------------------------------------------------
// Lister les demandes (admin)
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
// Obtenir une demande (admin)
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
// Approuver (admin)
// ---------------------------------------------------------------------------
async function approveRequest(requestId, { commentaire, adminUser }) {
  const request = await CongeActionRequest.findOne({
    where: { id: requestId, entreprise_id: adminUser.entreprise_id, statut: 'pending' },
    include: [
      { model: Conge, as: 'conge', include: [{ model: CongeType, as: 'conge_type' }] },
      { model: Utilisateur, as: 'utilisateur', attributes: ['id', 'prenom', 'nom', 'email', 'service'] },
    ],
  });
  if (!request) { const err = new Error('Demande introuvable ou déjà traitée'); err.statusCode = 404; throw err; }

  const conge = request.conge;
  const employe = request.utilisateur;
  const employe_nom = `${employe.prenom || ''} ${employe.nom || ''}`.trim();
  const action = typeLabel(request.type);

  // Exécuter l'action réelle
  if (request.type === 'cancel') {
    await congesService.deleteConge(conge.id, adminUser, { commentaire: commentaire || request.commentaire_employe });
  } else {
    await congesService.updateConge(conge.id, {
      date_debut: request.date_debut_demandee,
      date_fin: request.date_fin_demandee,
      debut_demi_journee: request.debut_demi_journee_demandee || 'matin',
      fin_demi_journee: request.fin_demi_journee_demandee || 'apres_midi',
    }, adminUser);
  }

  // Marquer la demande comme approuvée
  await request.update({ statut: 'approved', commentaire_admin: commentaire || null });

  const adminNom = `${adminUser.prenom || ''} ${adminUser.nom || ''}`.trim() || "L'administrateur";
  const npRow = nouvellePeriodeRow(request);

  const baseRules = await getEntrepriseLeaveRules(conge.entreprise_id);
  const leaveRules = getEffectiveLeaveRules(baseRules, employe?.service || null);

  // Construire les lignes de détail selon le type d'action
  let detailRows = '';
  if (request.type === 'cancel') {
    detailRows = `<tr><td style="padding:8px 12px;background:#f9fafb;border:1px solid #e5e7eb;color:#6b7280;font-size:14px;">Periode annulee</td>
      <td style="padding:8px 12px;border:1px solid #e5e7eb;font-weight:600;">${formatDateFR(conge.date_debut)} au ${formatDateFR(conge.date_fin)}</td></tr>`;
  } else {
    detailRows = `<tr><td style="padding:8px 12px;background:#f9fafb;border:1px solid #e5e7eb;color:#6b7280;font-size:14px;">Ancienne periode</td>
      <td style="padding:8px 12px;border:1px solid #e5e7eb;font-style:italic;color:#6b7280;">${formatDateFR(conge.date_debut)} au ${formatDateFR(conge.date_fin)}</td></tr>
      <tr><td style="padding:8px 12px;background:#f9fafb;border:1px solid #e5e7eb;color:#6b7280;font-size:14px;">Nouvelle periode</td>
      <td style="padding:8px 12px;border:1px solid #e5e7eb;font-weight:600;">${formatDateFR(request.date_debut_demandee)} au ${formatDateFR(request.date_fin_demandee)}</td></tr>`;
  }

  const employeMessage = request.type === 'cancel'
    ? `Votre demande d'annulation a ete approuvee par <strong>${adminNom}</strong>. Votre conge a ete annule et votre solde recalcule.`
    : `Votre demande de modification a ete approuvee par <strong>${adminNom}</strong>.`;

  // Email à l'employé
  if (employe?.email) {
    fireEmail({
      to: employe.email,
      subject: `Demande d'${action} approuvee`,
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
      message: `Votre demande d'${action} a été approuvée par ${adminNom}`,
      url: `/conges/${conge.id}`,
    });
  }

  // Email aux managers — pour information
  const workflowNeedsManager = ['manager_only', 'manager', 'manager_admin'].includes(leaveRules.approval_workflow);
  if (workflowNeedsManager) {
    const managers = await Utilisateur.findAll({ where: { entreprise_id: conge.entreprise_id, role: 'manager', statut: 'actif' } });
    for (const mgr of managers) {
      if (mgr.email) {
        const managerMessage = request.type === 'cancel'
          ? `La demande d'annulation de <strong>${employe_nom}</strong> a ete approuvee par ${adminNom}. Le conge a ete supprime.`
          : `La demande de modification de <strong>${employe_nom}</strong> a ete approuvee par ${adminNom}.`;
        fireEmail({
          to: mgr.email,
          subject: `Pour information - demande d'${action} approuvee`,
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
          message: `Demande d'${action} de ${employe_nom} approuvée par ${adminNom}`,
          url: `/conges/${conge.id}`,
        });
      }
    }
  }

  return request;
}

// ---------------------------------------------------------------------------
// Refuser (admin)
// ---------------------------------------------------------------------------
async function rejectRequest(requestId, { commentaire, adminUser }) {
  if (!commentaire?.trim()) {
    const err = new Error('Le motif du refus est obligatoire'); err.statusCode = 400; throw err;
  }

  const request = await CongeActionRequest.findOne({
    where: { id: requestId, entreprise_id: adminUser.entreprise_id, statut: 'pending' },
    include: [
      { model: Conge, as: 'conge', include: [{ model: CongeType, as: 'conge_type' }] },
      { model: Utilisateur, as: 'utilisateur', attributes: ['id', 'prenom', 'nom', 'email'] },
    ],
  });
  if (!request) { const err = new Error('Demande introuvable ou déjà traitée'); err.statusCode = 404; throw err; }

  await request.update({ statut: 'rejected', commentaire_admin: commentaire.trim() });

  const conge = request.conge;
  const employe = request.utilisateur;
  const action = typeLabel(request.type);

  if (employe?.email) {
    fireEmail({
      to: employe.email,
      subject: `Demande d'${action} refusee`,
      templateName: 'leave-action-rejected',
      data: {
        destinataire_prenom: employe.prenom || 'Collaborateur',
        type_action: action,
        type_conge: conge.conge_type?.libelle || 'Congé',
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
      message: `Votre demande d'${action} a été refusée`,
      url: `/conges/${conge.id}`,
    });
  }

  return request;
}

module.exports = { submitRequest, listRequests, getRequest, approveRequest, rejectRequest };
