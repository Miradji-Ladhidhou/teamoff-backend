'use strict';

const COMMENT_FIELDS = [
  'commentaire',
  'commentaire_employe',
  'commentaire_manager',
  'commentaire_admin',
  'ancien_commentaire_employe',
  'nouveau_commentaire_employe',
  'detail_rows',
  'annee_compteur_note_html',
  'overlap_warning_html',
  'comments_rows',
  'motif',
];

function prepareEmailNotificationMode(subject, templateName, data = {}) {
  const mode = data.notification_delivery?.canAct === false ? 'information' : data.notification_mode;
  const preparedData = { ...data };
  delete preparedData.notification_mode;
  delete preparedData.notification_delivery;
  delete preparedData.notification_comments_allowed;
  if (data.notification_delivery?.canView === false) {
    preparedData.action_url = '';
    preparedData.hide_record_links = true;
  }

  if (mode === 'information') {
    preparedData.action_requise = 'Pour information';
    preparedData.message_role = data.notification_owner
      ? 'Cette mise à jour concerne votre demande. Aucune validation n’est attendue de votre part.'
      : data.destinataire_role === 'admin_entreprise'
        ? 'Vous recevez ce suivi dans votre périmètre administratif. Aucune validation n’est attendue de votre part à cette étape.'
        : 'Cette demande est transmise à titre informatif. Aucune validation n’est attendue de votre part.';
    preparedData.sous_titre = 'Pour information';
    preparedData.bouton_action = '';
    if (preparedData.titre_email) preparedData.titre_email = `Pour information — ${preparedData.titre_email.replace(/\s*[—:-]?\s*action requise\b/gi, '').trim()}`;
    for (const field of data.notification_owner ? [] : COMMENT_FIELDS) {
      if (data.notification_comments_allowed === true && data.notification_delivery?.canView !== false
        && (/commentaire/.test(field) || field === 'comments_rows' || field === 'motif')) continue;
      if (Object.prototype.hasOwnProperty.call(preparedData, field)) preparedData[field] = '';
    }

    const normalizedSubject = String(subject || 'Notification congé')
      .replace(/^action requise\s*[—:-]?\s*/i, '')
      .replace(/\s*[—:-]?\s*action requise\b/gi, '').trim();
    subject = normalizedSubject.toLowerCase().startsWith('pour information')
      ? normalizedSubject
      : `Pour information — ${normalizedSubject}`;
  } else if (mode === 'action') {
    preparedData.action_requise ||= 'Action requise';
    preparedData.message_role ||= 'Cette demande attend votre validation.';
  }

  if (templateName === 'leave-new-request-manager') {
    preparedData.action_requise ||= 'Action requise';
    preparedData.message_role ||= 'Une nouvelle demande de congé a été soumise et attend votre validation.';
  }

  if (templateName === 'leave-manager-approved-admin') {
    preparedData.action_requise ||= 'Votre validation finale est requise';
    preparedData.message_role ||= 'Cette demande attend votre validation finale.';
  }

  if (templateName === 'leave-pending-reminder') {
    preparedData.action_requise ||= 'Action requise de votre part';
    preparedData.message_role ||= 'Cette demande attend toujours une décision.';
    if (mode !== 'information') {
      preparedData.bouton_action ||= `<p><a href="${preparedData.action_url || '#'}">Traiter la demande</a></p>`;
    }
  }

  if (templateName === 'leave-reservation-reminder') {
    preparedData.action_requise ||= 'Action requise';
    preparedData.message_role ||= 'Vérifiez le solde du collaborateur et validez ou refusez cette réservation avant son départ.';
    if (mode !== 'information') {
      preparedData.bouton_action ||= `<p><a href="${preparedData.action_url || '#'}">Traiter la réservation</a></p>`;
    }
  }

  return { subject, data: preparedData };
}

function removeUnavailableRecordLinks(html, data = {}) {
  return data.hide_record_links
    ? html.replace(/<a\b[^>]*href=(["'])\1[^>]*>[\s\S]*?<\/a>/gi, '')
    : html;
}

module.exports = { prepareEmailNotificationMode, removeUnavailableRecordLinks };