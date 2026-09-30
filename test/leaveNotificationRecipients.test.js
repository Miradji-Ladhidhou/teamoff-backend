'use strict';

const bcrypt = require('bcrypt');
const { Entreprise, Utilisateur } = require('../src/models');
const { getLeaveNotificationRecipients } = require('../src/services/leaveNotificationRecipients');

const RUN_ID = Date.now();
let entreprise;
let managerFinance;
let managerIT;
let admin;

beforeAll(async () => {
  const passwordHash = await bcrypt.hash('Test1234!', 10);
  entreprise = await Entreprise.create({
    nom: `LeaveRecipients_${RUN_ID}`,
    politique_conges: {},
    parametres: {},
    statut: 'active',
  });
  [managerFinance, managerIT, admin] = await Promise.all([
    Utilisateur.create({
      entreprise_id: entreprise.id,
      prenom: 'Manager',
      nom: 'Finance',
      email: `manager.finance.${RUN_ID}@test.internal`,
      role: 'manager',
      statut: 'actif',
      service: 'Finance',
      password_hash: passwordHash,
    }),
    Utilisateur.create({
      entreprise_id: entreprise.id,
      prenom: 'Manager',
      nom: 'IT',
      email: `manager.it.${RUN_ID}@test.internal`,
      role: 'manager',
      statut: 'actif',
      service: 'IT',
      password_hash: passwordHash,
    }),
    Utilisateur.create({
      entreprise_id: entreprise.id,
      prenom: 'Admin',
      nom: 'Entreprise',
      email: `admin.${RUN_ID}@test.internal`,
      role: 'admin_entreprise',
      statut: 'actif',
      password_hash: passwordHash,
    }),
  ]);
});

afterAll(async () => {
  if (!entreprise) return;
  await Utilisateur.destroy({ where: { entreprise_id: entreprise.id } });
  await Entreprise.destroy({ where: { id: entreprise.id } });
});

test('manager_admin à la première étape cible le manager du service seulement', async () => {
  const recipients = await getLeaveNotificationRecipients({
    entrepriseId: entreprise.id,
    service: 'Finance',
    workflow: 'manager_admin',
  });

  expect(recipients.map((recipient) => recipient.id)).toEqual([managerFinance.id]);
});

test('manager_admin après validation manager cible seulement l’admin', async () => {
  const recipients = await getLeaveNotificationRecipients({
    entrepriseId: entreprise.id,
    service: 'Finance',
    workflow: 'manager_admin',
    stage: 'admin',
  });

  expect(recipients.map((recipient) => recipient.id)).toEqual([admin.id]);
});

test('admin_only n’envoie qu’aux administrateurs', async () => {
  const recipients = await getLeaveNotificationRecipients({
    entrepriseId: entreprise.id,
    service: 'Finance',
    workflow: 'admin_only',
  });

  expect(recipients.map((recipient) => recipient.id)).toEqual([admin.id]);
});

test('fallback aux managers de l’entreprise si aucun manager du service', async () => {
  const recipients = await getLeaveNotificationRecipients({
    entrepriseId: entreprise.id,
    service: 'RH',
    workflow: 'manager',
  });

  expect(recipients.map((recipient) => recipient.id)).toEqual(
    expect.arrayContaining([managerFinance.id, managerIT.id])
  );
  expect(recipients.map((recipient) => recipient.id)).not.toContain(admin.id);
});

test('une réservation de workflow auto informe les admins', async () => {
  const recipients = await getLeaveNotificationRecipients({
    entrepriseId: entreprise.id,
    service: 'Finance',
    workflow: 'auto',
    reservation: true,
  });

  expect(recipients.map((recipient) => recipient.id)).toEqual([admin.id]);
});
