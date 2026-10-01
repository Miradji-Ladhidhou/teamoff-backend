'use strict';

const { prepareEmailNotificationMode } = require('../src/utils/emailNotificationMode');

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