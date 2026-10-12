'use strict';

const { prepareEmailNotificationMode } = require('../src/utils/emailNotificationMode');
const { removeUnavailableRecordLinks } = require('../src/utils/emailNotificationMode');
const emailService = require('../src/services/emailService');

test('un rappel informatif n’a ni motif sensible ni bouton de traitement', () => {
  const result = prepareEmailNotificationMode(
    'Rappel : demande en attente',
    'leave-pending-reminder',
    {
      notification_mode: 'information',
      commentaire_employe: 'motif privé',
      overlap_warning_html: '<div>details privés</div>',
      annee_compteur_note_html: '<div>solde privé</div>',
      action_url: '/conges/leave-id',
    }
  );

  expect(result.subject).toMatch(/^Pour information/);
  expect(result.data.action_requise).toBe('Pour information');
  expect(result.data.commentaire_employe).toBe('');
  expect(result.data.overlap_warning_html).toBe('');
  expect(result.data.annee_compteur_note_html).toBe('');
  expect(result.data.bouton_action).toBe('');
  expect(result.data.message_role).toMatch(/Aucune validation n’est attendue/);
});

test('un rappel d’action conserve son bouton de traitement', () => {
  const result = prepareEmailNotificationMode(
    'Rappel : demande en attente',
    'leave-pending-reminder',
    { notification_mode: 'action', action_url: '/conges/leave-id' }
  );

  expect(result.data.action_requise).toMatch(/Action requise/);
  expect(result.data.bouton_action).toContain('/conges/leave-id');
});

test('le workflow admin_only peut marquer la création comme informative sans commentaire', () => {
  const result = prepareEmailNotificationMode(
    'Nouvelle demande de congé',
    'leave-new-request-manager',
    { notification_mode: 'information', commentaire_employe: 'motif privé' }
  );

  expect(result.data.action_requise).toBe('Pour information');
  expect(result.data.commentaire_employe).toBe('');
  expect(result.data.message_role).toMatch(/Aucune validation n’est attendue/);
});

test('un refus admin communiqué au manager masque le commentaire', () => {
  const result = prepareEmailNotificationMode(
    'Pour information — congé refusé par l’administrateur',
    'leave-rejected-manager-info',
    { notification_mode: 'information', commentaire: 'motif privé' }
  );

  expect(result.subject).toMatch(/^Pour information/);
  expect(result.data.commentaire).toBe('');
});

test('email seul : aucun lien de consultation, aucun libellé contradictoire et aucune action', async () => {
  const result = prepareEmailNotificationMode(
    'Action requise — demande de modification',
    'leave-action-request-admin',
    {
      notification_mode: 'action',
      notification_delivery: { canAct: false, canView: false },
      titre_email: 'Demande de modification — action requise',
      commentaire_employe: 'Motif privé',
      bouton_action: '<a href="/conges/demandes">Traiter</a>',
      action_url: '/conges/123',
    }
  );
  expect(result.subject).toBe('Pour information — demande de modification');
  expect(result.data.titre_email).not.toMatch(/action requise/i);
  expect(result.data.action_url).toBe('');
  expect(result.data.bouton_action).toBe('');
  expect(result.data.commentaire_employe).toBe('');
  expect(result.data.notification_delivery).toBeUndefined();
  const html = await emailService.buildHtml('leave-new-request-manager', result.data);
  expect(html).not.toContain('Consulter la demande');
  expect(html).not.toContain('/conges/123');
});

test('les liens des destinataires autorisés restent inchangés', () => {
  const html = '<a href="/conges/123">Voir</a>';
  expect(removeUnavailableRecordLinks(html, {})).toBe(html);
});