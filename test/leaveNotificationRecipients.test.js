'use strict';

const bcrypt = require('bcrypt');
const { Entreprise, Utilisateur, Notification } = require('../src/models');
const { getLeaveNotificationRecipients, notifyAdminsNoServiceManager } = require('../src/services/leaveNotificationRecipients');
const { canManagerAccessService, getManagerServicePermissions } = require('../src/services/politiqueConges');
const emailService = require('../src/services/emailService');

const RUN_ID = Date.now();
let entreprise;
let managerFinance;
let managerIT;
let admin;

beforeAll(async () => {
  jest.spyOn(emailService, 'sendEmail').mockResolvedValue(undefined);
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
  jest.restoreAllMocks();
  if (!entreprise) return;
  await Utilisateur.destroy({ where: { entreprise_id: entreprise.id } });
  await Entreprise.destroy({ where: { id: entreprise.id } });
});

test('manager_admin à la première étape cible le manager et informe l’admin', async () => {
  const recipients = await getLeaveNotificationRecipients({
    entrepriseId: entreprise.id,
    service: 'Finance',
    workflow: 'manager_admin',
  });

  expect(recipients.map((recipient) => recipient.id)).toEqual([managerFinance.id, admin.id]);
  expect(recipients.find(recipient => recipient.id === admin.id).notification_mode).toBe('information');
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

test('admin_only envoie une information aux managers en lecture globale, jamais une action', async () => {
  const originalPolicy = entreprise.politique_conges;
  try {
    await entreprise.update({
      politique_conges: {
        service_policies: {
          IT: { manager_can_view_all_services: true, manager_can_validate_all_services: false },
        },
      },
    });

    const recipients = await getLeaveNotificationRecipients({
      entrepriseId: entreprise.id,
      service: 'Finance',
      workflow: 'admin_only',
    });

    expect(recipients.find((recipient) => recipient.id === admin.id)?.notification_mode).toBe('action');
    expect(recipients.find((recipient) => recipient.id === managerIT.id)?.notification_mode).toBe('information');
    expect(recipients.find((recipient) => recipient.id === managerFinance.id)).toBeUndefined();
  } finally {
    await entreprise.update({ politique_conges: originalPolicy });
  }
});

test('aucun manager hors service n’est utilisé en fallback', async () => {
  const recipients = await getLeaveNotificationRecipients({
    entrepriseId: entreprise.id,
    service: 'RH',
    workflow: 'manager',
  });

  expect(recipients.map(recipient => recipient.id)).toEqual([admin.id]);
  expect(recipients[0].notification_mode).toBe('information');
});

test('les admins sont alertés si aucun manager actif n’est affecté au service', async () => {
  emailService.sendEmail.mockClear();
  await Notification.destroy({ where: { utilisateur_id: admin.id, type: 'manager_service_unassigned' } });
  await notifyAdminsNoServiceManager({
    entrepriseId: entreprise.id,
    service: 'RH',
    reference: 'CONGE-123',
  });
  await notifyAdminsNoServiceManager({
    entrepriseId: entreprise.id,
    service: 'RH',
    reference: 'CONGE-123',
  });

  const alerts = await Notification.findAll({
    where: { utilisateur_id: admin.id, type: 'manager_service_unassigned' },
  });
  expect(alerts).toHaveLength(1);
  expect(alerts.some((alert) => alert.message.includes('CONGE-123'))).toBe(true);
  expect(emailService.sendEmail).toHaveBeenCalledTimes(1);
  expect(emailService.sendEmail.mock.calls[0][0]).toBe(admin.email);
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

test('les permissions de portée sont limitées au service par défaut', () => {
  const manager = { role: 'manager', service: 'Finance' };
  const rules = { service_policies: { Finance: {} } };

  expect(getManagerServicePermissions(rules, manager)).toEqual({
    canViewAllServices: false,
    canValidateAllServices: false,
  });
  expect(canManagerAccessService(manager, 'Finance', rules, 'view')).toBe(true);
  expect(canManagerAccessService(manager, 'IT', rules, 'view')).toBe(false);
  expect(canManagerAccessService(manager, 'IT', rules, 'validate')).toBe(false);
});

test('la validation interservices implique la visibilité interservices', () => {
  const manager = { role: 'manager', service: 'Finance' };
  const rules = { service_policies: { Finance: { manager_can_validate_all_services: true } } };

  expect(getManagerServicePermissions(rules, manager)).toEqual({
    canViewAllServices: true,
    canValidateAllServices: true,
  });
  expect(canManagerAccessService(manager, 'IT', rules, 'view')).toBe(true);
  expect(canManagerAccessService(manager, 'IT', rules, 'validate')).toBe(true);
});

test('la visibilité interservices seule ne donne pas le droit de valider', () => {
  const manager = { role: 'manager', service: 'Finance' };
  const rules = { service_policies: { Finance: { manager_can_view_all_services: true } } };

  expect(canManagerAccessService(manager, 'IT', rules, 'view')).toBe(true);
  expect(canManagerAccessService(manager, 'IT', rules, 'validate')).toBe(false);
});

test('un manager sans service ne reçoit pas de portée interservices implicite', () => {
  const manager = { role: 'manager', service: null };
  const rules = { service_policies: { Finance: { manager_can_view_all_services: true } } };

  expect(canManagerAccessService(manager, 'Finance', rules, 'view')).toBe(false);
  expect(canManagerAccessService(manager, null, rules, 'view')).toBe(false);
});

describe('canaux et participation interservices', () => {
  async function withConfig(config, run) {
    const previous = entreprise.politique_conges;
    try {
      await entreprise.update({ politique_conges: { service_policies: {
        IT: { manager_cross_service: { conges: config } },
      } } });
      await run();
    } finally {
      await entreprise.update({ politique_conges: previous });
    }
  }

  test.each([
    [true, false, 'information'],
    [false, true, 'information'],
    [true, true, 'action'],
    [false, false, 'action'],
  ])('sépare email=%s application=%s participation=%s sans changer le manager local', async (email, in_app, participation) => {
    await withConfig({ view: participation === 'action', email, in_app, participation }, async () => {
      const recipients = await getLeaveNotificationRecipients({
        entrepriseId: entreprise.id, service: 'Finance', workflow: 'manager_admin',
      });
      const local = recipients.find(user => user.id === managerFinance.id);
      expect(local.notification_mode).toBe('action');
      expect(local.email).toBe(managerFinance.email);
      const cross = recipients.find(user => user.id === managerIT.id);
      if (!email && !in_app) {
        expect(cross).toBeUndefined();
      } else {
        expect(Boolean(cross.email)).toBe(email);
        expect(cross.notification_delivery.in_app).toBe(in_app);
        expect(cross.notification_mode).toBe(participation);
        const service = require('../src/services/notificationService');
        const notification = await service.creerNotification({
          entreprise_id: entreprise.id, utilisateur_id: cross.id,
          message: 'Test interservices', type: 'scope_test', url: '/conges/123',
          delivery: cross.notification_delivery,
        });
        if (in_app) {
          expect(notification.message).toMatch(participation === 'action' ? /^Action requise/ : /^Pour information/);
          expect(notification.url).toBe(participation === 'action' ? '/conges/123' : null);
          await notification.destroy();
        } else {
          expect(notification).toBeNull();
        }
      }
    });
  });

  test.each([
    ['manager_admin', 'manager', 'action'],
    ['manager_admin', 'admin', 'information'],
    ['admin_only', 'manager', 'information'],
    ['auto', 'manager', 'information'],
  ])('le workflow %s à l’étape %s produit %s même si peut agir est activé', async (workflow, stage, mode) => {
    await withConfig({ view: true, email: true, in_app: true, participation: 'action' }, async () => {
      const recipients = await getLeaveNotificationRecipients({ entrepriseId: entreprise.id, service: 'Finance', workflow, stage });
      expect(recipients.find(user => user.id === managerIT.id).notification_mode).toBe(mode);
    });
  });

  test('le demandeur et les décisions terminées ne reçoivent jamais une action requise', async () => {
    await withConfig({ view: true, email: true, in_app: true, participation: 'action' }, async () => {
      const own = await getLeaveNotificationRecipients({
        entrepriseId: entreprise.id, service: 'IT', workflow: 'manager', requesterId: managerIT.id,
      });
      expect(own.find(user => user.id === managerIT.id).notification_mode).toBe('information');
      const finished = await getLeaveNotificationRecipients({
        entrepriseId: entreprise.id, service: 'Finance', workflow: 'manager', informationOnly: true,
      });
      expect(finished.every(user => user.notification_mode === 'information')).toBe(true);
    });
  });
});
