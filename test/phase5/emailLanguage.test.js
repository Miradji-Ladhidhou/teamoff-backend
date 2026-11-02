'use strict';

jest.mock('../../src/models', () => ({
  Utilisateur: { findOne: jest.fn().mockResolvedValue(null) },
  EmailLog: { create: jest.fn().mockResolvedValue({}) },
}));
jest.mock('../../src/services/systemSettingsService', () => ({
  getSettings: jest.fn().mockResolvedValue({ emailNotifications: true }),
}));
jest.mock('../../src/services/businessNotificationContext', () => ({
  sendConfiguredEmail: jest.fn(() => { throw new Error('Envoi externe interdit dans ce test'); }),
}));
jest.mock('../../src/utils/logger', () => ({ error: jest.fn(), debug: jest.fn() }));

const fs = require('fs');
const path = require('path');
const emailService = require('../../src/services/emailService');
const { prepareEmailNotificationMode } = require('../../src/utils/emailNotificationMode');

const templatesDir = path.join(__dirname, '../../src/templates/emails');
const user = { prenom: 'Camille', nom: 'Fictif', email: 'fiction@example.invalid' };
const stripHtml = html => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').replace(/\s+([.,])/g, '$1').trim();
let environment;

async function render(template, data = {}) {
  const source = fs.readFileSync(path.join(templatesDir, `${template}.html`), 'utf8');
  const defaults = Object.fromEntries([...source.matchAll(/{{(\w+)}}/g)].map(([, key]) => [key, '']));
  const prepared = prepareEmailNotificationMode('Notification', template, {
    ...defaults, destinataire_prenom: user.prenom, signature: 'Entreprise fictive', ...data,
  });
  const html = await emailService.buildHtml(template, prepared.data);
  expect(html).not.toMatch(/{{\w+}}/);
  return stripHtml(html);
}

afterEach(() => {
  if (jest.isMockFunction(emailService.sendEmail)) emailService.sendEmail.mockRestore();
  environment?.restore();
  environment = undefined;
});

test.each(fs.readdirSync(templatesDir).filter(name => name.endsWith('.html')))(
  '%s ne laisse aucune variable non remplacée',
  async filename => { await render(filename.replace(/\.html$/, '')); }
);

describe.each(['modification', 'annulation'])('Demande de type %s', action => {
  test.each([
    ['leave-action-approved', 'Demande approuvée'],
    ['leave-action-rejected', 'Demande refusée'],
    ['leave-action-request-employee', 'Demande soumise'],
  ])('%s ne suppose ni élision ni rôle du décideur', async (template, title) => {
    const text = await render(template, { type_action: action });
    expect(text).toContain(`${title} : ${action}`);
    expect(text).not.toContain('de annulation');
    expect(text).not.toMatch(/administrateur|Commentaire admin/);
    if (template === 'leave-action-request-employee') {
      expect(text).toContain(`Vous avez demandé une ${action} du congé ci-dessous.`);
    }
  });

  test.each(['action', 'information'])('le destinataire %s conserve son intervention attendue', async mode => {
    const text = await render('leave-action-request-admin', {
      type_action: action, demandeur_nom: 'Camille Fictif', notification_mode: mode,
    });
    expect(text).toContain(`Camille Fictif a demandé une ${action} de son congé validé.`);
    expect(text).toContain(mode === 'action'
      ? 'Cette demande attend votre validation.'
      : 'Aucune validation n’est attendue de votre part.');
  });
});

test.each([
  'demande de congé en attente', 'réservation de congé',
  'congé validé par le manager', 'congé validé définitivement',
])('annulation : le libellé « %s » ne dicte aucun accord', async label => {
  const confirmation = await render('leave-cancelled-self-confirm', { statut_conge_label: label });
  expect(confirmation).toContain(`L'annulation de votre ${label} est confirmée.`);
  const information = await render('leave-cancelled-by-employee', {
    statut_conge_label: label, demandeur_nom: 'Camille Fictif',
  });
  expect(information).toContain(`Camille Fictif a effectué l'annulation suivante : ${label}.`);
  expect(information).not.toMatch(/son (?:demande|réservation)/);
});

test.each(['Congés payés', 'RTT', 'Absence autorisée'])('le type « %s » ne dicte aucun accord', async label => {
  for (const [template, verb] of [['leave-cancelled-employee', 'annulé'], ['leave-updated-employee', 'modifié']]) {
    const text = await render(template, { type_conge: label, auteur_action: 'Alex Fictif' });
    expect(text).toContain(`Votre congé validé de type « ${label} » a été ${verb} par Alex Fictif.`);
  }
});

test.each(['action', 'information'])('rappel %s : pas de nombre isolé après une phrase complète', async mode => {
  const text = await render('leave-pending-reminder', { notification_mode: mode, jours_attente: 3 });
  expect(text).toContain('Rappel : demande en attente depuis 3 jour(s)');
  expect(text).not.toMatch(/\.\s+3 jour\(s\)/);
  expect(text).toContain(mode === 'action' ? 'Traiter la demande' : 'Aucune validation n’est attendue');
  if (mode === 'information') expect(text).not.toContain('Traiter la demande');
});

test.each([
  ['absence_exceptionnelle', 'Absence exceptionnelle'],
  ['maladie', 'Arrêt maladie'],
])('absence %s : le libellé lisible remplace le code', async (code, label) => {
  const text = await render('absence-notification', { type_absence: code, type_absence_libelle: label });
  expect(text).toContain(`Type d'absence ${label}`);
  expect(text).not.toContain(`Type d'absence ${code}`);
});

test('validation intermédiaire : temps du verbe et statut explicites', async () => {
  const text = await render('leave-manager-validated-employee');
  expect(text).toContain('dès que cette étape sera finalisée.');
  expect(text).toContain("En attente de validation par l'administrateur");
});

test('attestation : accord au féminin', async () => {
  expect(await render('attestation')).toContain('Générée automatiquement via TeamOff');
});

test.each([undefined, 'Application fictive'])('bienvenue avec nom de plateforme %s', async name => {
  const env = { ...process.env };
  if (name === undefined) delete env.EMAIL_NAME;
  else env.EMAIL_NAME = name;
  environment = jest.replaceProperty(process, 'env', env);
  const send = jest.spyOn(emailService, 'sendEmail').mockResolvedValue({});
  await emailService.sendWelcomeEmail(user, { nom: 'Entreprise fictive' }, 'fictif');
  expect(send.mock.calls[0][1]).toBe(`Bienvenue sur ${name || 'TeamOff'} !`);
});

test('le rôle apprenti dispose de son libellé', async () => {
  const send = jest.spyOn(emailService, 'sendEmail').mockResolvedValue({});
  await emailService.sendRoleChanged(user, 'apprenti', 'employe');
  expect(send.mock.calls[0][3]).toMatchObject({ ancien_role: 'Apprenti', nouveau_role: 'Employé' });
});

test.each([['active', 'Actif'], ['inactive', 'Inactif'], ['suspendue', 'Suspendu']])(
  'le statut entreprise %s est présenté en français',
  async (statut, label) => {
    const send = jest.spyOn(emailService, 'sendEmail').mockResolvedValue({});
    await emailService.sendEntrepriseCreatedEmail(user, { nom: 'Entreprise fictive', statut });
    expect(send.mock.calls[0][3].entreprise_statut).toBe(label);
    expect(send.mock.calls[0][3].content).toContain(`<strong>${label}</strong>`);
  }
);

test('le moteur historique conserve les accents de son enveloppe et de sa signature', async () => {
  jest.resetModules();
  environment = jest.replaceProperty(process, 'env', { NODE_ENV: 'test', EMAIL_NAME: 'TeamOff' });
  const sendMail = jest.fn().mockResolvedValue({ messageId: 'fictif' });
  require('nodemailer').createTransport.mockReturnValue({ sendMail });
  require('dns').promises.resolve4.mockResolvedValue(['127.0.0.1']);
  const notifications = require('../../src/services/notificationService');
  await notifications.sendEmailLegacy({ to: user.email, subject: 'Notification' });
  const { html } = sendMail.mock.calls[0][0];
  expect(html).toContain('Une mise à jour est disponible.');
  expect(html).toContain("L'équipe TeamOff");
  expect(html).toContain('Cet email est envoyé automatiquement, merci de ne pas y répondre.');
  expect(html).toContain('Accéder à la plateforme');
});
