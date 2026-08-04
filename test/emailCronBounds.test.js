'use strict';
/**
 * emailCronBounds.test.js — Fix #26
 *
 * Vérifie que les relances cron sont bornées :
 *  - runPendingLeaveReminders : au plus 2 relances par demande (J+3 et J+7)
 *  - runInvitationReminders   : au plus 3 relances par invitation (J+1, J+3, J+7)
 *
 * Méthode : mock emailService, données réelles en DB, appel direct des fonctions.
 */

jest.mock('../src/services/emailService', () => ({
  sendLeavePendingReminder:  jest.fn().mockResolvedValue(undefined),
  sendInvitationReminder:    jest.fn().mockResolvedValue(undefined),
  sendLeaveReminder:         jest.fn().mockResolvedValue(undefined),
  sendMonthlyReport:         jest.fn().mockResolvedValue(undefined),
  sendWeeklyManagerSummary:  jest.fn().mockResolvedValue(undefined),
  sendEmail:                 jest.fn().mockResolvedValue(undefined),
  getSmtpConfig:             jest.fn().mockResolvedValue({}),
}));

const bcrypt  = require('bcrypt');
const dayjs   = require('dayjs');
const { sequelize, Entreprise, Utilisateur, Conge, CongeType } = require('../src/models');
const emailService = require('../src/services/emailService');
const { runPendingLeaveReminders, runInvitationReminders } = require('../src/cron/emailCron');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function daysAgo(n) {
  return dayjs().subtract(n, 'day').subtract(1, 'hour').toDate(); // milieu du créneau
}

let ctx; // { entreprise, manager, employe, congeType }

beforeAll(async () => {
  const entreprise = await Entreprise.create({
    nom: 'Cron Bounds Test',
    politique_conges: {},
    parametres: {},
    statut: 'active',
  });

  const passwordHash = await bcrypt.hash('Test1234!', 10);

  const manager = await Utilisateur.create({
    entreprise_id: entreprise.id,
    prenom: 'Manager', nom: 'Cron',
    email: `mgr.cron.${Date.now()}@test.internal`,
    role: 'manager',
    password_hash: passwordHash,
    statut: 'actif',
    service: 'dev',
  });

  const employe = await Utilisateur.create({
    entreprise_id: entreprise.id,
    prenom: 'Employe', nom: 'Cron',
    email: `emp.cron.${Date.now()}@test.internal`,
    role: 'employe',
    password_hash: passwordHash,
    statut: 'actif',
    service: 'dev',
  });

  const congeType = await CongeType.create({
    entreprise_id: entreprise.id,
    code: 'CP_CRON',
    libelle: 'Congés payés cron',
    quota_annuel: 25,
    demi_journee_autorisee: true,
  });

  ctx = { entreprise, manager, employe, congeType };
});

afterAll(async () => {
  await Conge.destroy({ where: { entreprise_id: ctx.entreprise.id } });
  await CongeType.destroy({ where: { entreprise_id: ctx.entreprise.id } });
  await Utilisateur.destroy({ where: { entreprise_id: ctx.entreprise.id } });
  await Entreprise.destroy({ where: { id: ctx.entreprise.id } });
});

beforeEach(() => {
  emailService.sendLeavePendingReminder.mockClear();
  emailService.sendInvitationReminder.mockClear();
});

// ---------------------------------------------------------------------------
// Helper : crée une demande de congé avec un created_at artificiel
async function createPendingConge(createdDaysAgo) {
  const conge = await Conge.create({
    entreprise_id:  ctx.entreprise.id,
    utilisateur_id: ctx.employe.id,
    conge_type_id:  ctx.congeType.id,
    date_debut:     dayjs().add(10, 'day').format('YYYY-MM-DD'),
    date_fin:       dayjs().add(12, 'day').format('YYYY-MM-DD'),
    debut_demi_journee: 'matin',
    fin_demi_journee:   'apres_midi',
    statut: 'en_attente_manager',
  });
  // Forcer created_at via SQL direct (Sequelize ne laisse pas écraser createdAt)
  await sequelize.query(
    `UPDATE conge SET created_at = :ts WHERE id = :id`,
    { replacements: { ts: daysAgo(createdDaysAgo), id: conge.id } }
  );
  return conge;
}

// Helper : crée un utilisateur en attente avec un created_at artificiel
async function createPendingUser(createdDaysAgo) {
  const user = await Utilisateur.create({
    entreprise_id: ctx.entreprise.id,
    prenom: 'Inv', nom: `D${createdDaysAgo}`,
    email: `inv.${createdDaysAgo}.${Date.now()}@test.internal`,
    role: 'employe',
    password_hash: await bcrypt.hash('Test1234!', 10),
    statut: 'en_attente',
    invite_token_hash: 'fakehash' + createdDaysAgo + Date.now(),
    last_login: null,
  });
  await sequelize.query(
    `UPDATE utilisateur SET created_at = :ts WHERE id = :id`,
    { replacements: { ts: daysAgo(createdDaysAgo), id: user.id } }
  );
  return user;
}

// ---------------------------------------------------------------------------
// SECTION 1 — runPendingLeaveReminders
// ---------------------------------------------------------------------------

describe('runPendingLeaveReminders — bornage des relances', () => {
  let conge30, conge10, conge3, conge7, conge1;

  beforeAll(async () => {
    [conge30, conge10, conge3, conge7, conge1] = await Promise.all([
      createPendingConge(30),
      createPendingConge(10),
      createPendingConge(3),
      createPendingConge(7),
      createPendingConge(1), // trop récent
    ]);
  });

  afterAll(async () => {
    await Conge.destroy({ where: { id: [conge30.id, conge10.id, conge3.id, conge7.id, conge1.id] } });
  });

  it('AVANT FIX : une demande de 30 jours ET 10 jours ET 3 jours sont toutes relancées (bug)', async () => {
    // Ce test documente le comportement PRÉ-FIX.
    // Avec le code original (created_at <= J-3), les 3 anciennes demandes seraient toutes ramassées.
    // APRÈS FIX : ce test doit échouer → les 3 anciens conges tombent HORS fenêtre J+3 / J+7.

    // On documente simplement le comportement ATTENDU après fix :
    // seuls J+3 et J+7 doivent être relancés.
    await runPendingLeaveReminders();

    const calls = emailService.sendLeavePendingReminder.mock.calls;
    const calledCongeIds = calls.map((c) => c[0].id); // premier argument = conge

    // APRÈS FIX : conge30 et conge10 NE doivent PAS être relancés
    expect(calledCongeIds).not.toContain(conge30.id);
    expect(calledCongeIds).not.toContain(conge10.id);

    // APRÈS FIX : conge de 1 jour NE doit PAS être relancé
    expect(calledCongeIds).not.toContain(conge1.id);

    // APRÈS FIX : conge3 (J+3) et conge7 (J+7) DOIVENT être relancés
    expect(calledCongeIds).toContain(conge3.id);
    expect(calledCongeIds).toContain(conge7.id);
  });

  it('borne maximale : au plus 2 relances envoyées (J+3 et J+7 uniquement)', async () => {
    await runPendingLeaveReminders();

    // Avec 5 conges en attente (1j, 3j, 7j, 10j, 30j), seuls les 2 bons doivent être ramassés.
    // 1 manager dans le service → 1 email par conge = 2 emails max.
    expect(emailService.sendLeavePendingReminder.mock.calls.length).toBeLessThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// SECTION 2 — runInvitationReminders
// ---------------------------------------------------------------------------

describe('runInvitationReminders — bornage des relances', () => {
  let userJ1, userJ3, userJ7, userJ10, userJ30;

  beforeAll(async () => {
    // J+1 = créé il y a 1 jour (dans la fenêtre 20h-28h)
    userJ1  = await createPendingUser(1);
    userJ3  = await createPendingUser(3);
    userJ7  = await createPendingUser(7);
    userJ10 = await createPendingUser(10);
    userJ30 = await createPendingUser(30);
  });

  afterAll(async () => {
    await Utilisateur.destroy({ where: { id: [userJ1.id, userJ3.id, userJ7.id, userJ10.id, userJ30.id] } });
  });

  it('APRÈS FIX : seules les invitations J+1, J+3, J+7 sont relancées', async () => {
    await runInvitationReminders();

    const calls = emailService.sendInvitationReminder.mock.calls;
    const calledUserIds = calls.map((c) => c[0].id);

    // J+10 et J+30 NE doivent PAS être relancés
    expect(calledUserIds).not.toContain(userJ10.id);
    expect(calledUserIds).not.toContain(userJ30.id);

    // J+3 et J+7 DOIVENT être relancés
    expect(calledUserIds).toContain(userJ3.id);
    expect(calledUserIds).toContain(userJ7.id);
  });

  it('borne maximale : au plus 3 relances (J+1 + J+3 + J+7) sur 5 utilisateurs', async () => {
    await runInvitationReminders();

    // 5 utilisateurs en attente, seuls 3 max doivent être relancés
    expect(emailService.sendInvitationReminder.mock.calls.length).toBeLessThanOrEqual(3);
  });
});
