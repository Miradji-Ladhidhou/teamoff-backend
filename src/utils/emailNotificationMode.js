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
  if (data.notification_delivery?.canView === false) {
    preparedData.action_url = '';
    preparedData.hide_record_links = true;
  }

  if (mode === 'information') {
    preparedData.action_requise = 'Pour information';
    preparedData.message_role = 'Cette demande est transmise à titre informatif. Aucune validation n’est attendue de votre part.';
    preparedData.sous_titre = 'Pour information';
    preparedData.bouton_action = '';
    if (preparedData.titre_email) preparedData.titre_email = `Pour information — ${preparedData.titre_email.replace(/\s*[—:-]?\s*action requise\b/gi, '').trim()}`;
    for (const field of COMMENT_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(preparedData, field)) preparedData[field] = '';
    }

    const normalizedSubject = String(subject || 'Notification congé').replace(/^action requise\s*[—:-]?\s*/i, '');
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