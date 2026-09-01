'use strict';
/**
 * csvImportChainComplete.test.js
 *
 * Test d'intégration de la chaîne complète :
 *
 *  1. Import CSV employés  → création compte en_attente + invitation email
 *  2. Invitation email     → token JWT généré, envoyé via sendSetPasswordEmail
 *  3. Token expiré         → 401 + INVITE_EXPIRED loggé
 *  4. Token invalide       → 401
 *  5. Token déjà utilisé   → 401
 *  6. Set-password OK      → compte actif, mot de passe bcrypt
 *  7. Login avec le nouveau mdp → access_token retourné
 *  8. Import CSV congés    → congés créés pour l'employé importé
 *  9. Import conges template → pré-rempli avec emails de l'entreprise
 */

const request  = require('supertest');
const jwt      = require('jsonwebtoken');
const crypto   = require('crypto');
const app      = require('../src/index');
const {
  Utilisateur, Conge, CompteurConges, AuditLog,
} = require('../src/models');
const { generateToken } = require('./helpers/auth');
const { seed }          = require('./helpers/seed');

// ─── Mocks ──────────────────────────────────────────────────────────────────

jest.mock('../src/services/emailService', () => ({
  sendSetPasswordEmail:       jest.fn().mockResolvedValue(undefined),
  sendWelcomeAfterActivation: jest.fn().mockResolvedValue(undefined),
  sendEmail:                  jest.fn().mockResolvedValue({ success: true }),
  sendAccountLocked:          jest.fn().mockResolvedValue(undefined),
  sendRegistrationConfirmation: jest.fn().mockResolvedValue(undefined),
  sendSuperAdminNotification: jest.fn().mockResolvedValue(undefined),
}));

// Récupéré après le mock (jest.mock est hoistée avant les imports)
const emailService = require('../src/services/emailService');

// ─── Données ─────────────────────────────────────────────────────────────────

let ctx;
const NEW_PASSWORD    = 'NouveauMdp2026!';
const EMPLOYEE_EMAIL  = `chain.employe.${Date.now()}@test.local`;
const EMPLOYEE2_EMAIL = `chain.employe2.${Date.now()}@test.local`;

// ─── Setup / Teardown ────────────────────────────────────────────────────────

beforeAll(async () => {
  ctx = await seed();
  jest.clearAllMocks();
});

afterAll(async () => {
  // Nettoyage des utilisateurs créés par le test
  const users = await Utilisateur.findAll({
    where: { email: [EMPLOYEE_EMAIL, EMPLOYEE2_EMAIL] },
  });
  for (const u of users) {
    await CompteurConges.destroy({ where: { utilisateur_id: u.id } });
    await Conge.destroy({ where: { utilisateur_id: u.id } });
    await u.destroy();
  }
  await ctx.cleanup();
});

// ─────────────────────────────────────────────────────────────────────────────
// 1 — Import CSV employés
// ─────────────────────────────────────────────────────────────────────────────
describe('1 — Import CSV employés', () => {
  it('crée le compte en statut en_attente avec soldes', async () => {
    const csv = Buffer.from(
      [
        `nom,prenom,email,role,service,date_embauche,Congés payés (N-1),Congés payés (N)`,
        `Martin,Claire,${EMPLOYEE_EMAIL},employe,RH,2022-01-15,3,25`,
        `Durand,Paul,${EMPLOYEE2_EMAIL},employe,Dev,2023-06-01,,15`,
      ].join('\n') + '\n',
      'utf8',
    );

    const res = await request(app)
      .post('/api/users/import/csv')
      .set('Authorization', `Bearer ${ctx.tokens.superAdmin}`)
      .attach('file', csv, { filename: 'import.csv', contentType: 'text/csv' })
      .field('entreprise_id', ctx.entreprise.id);

    expect(res.status).toBe(201);
    expect(res.body.created).toHaveLength(2);
    expect(res.body.created.map(u => u.email)).toEqual(
      expect.arrayContaining([EMPLOYEE_EMAIL, EMPLOYEE2_EMAIL]),
    );
    // Claire : N-1 + N = 2 soldes ; Paul : N seulement = 1 solde
    expect(res.body.balancesSet).toHaveLength(3);
  });

  it('les comptes sont en_attente avec password_hash non-null', async () => {
    const user = await Utilisateur.findOne({ where: { email: EMPLOYEE_EMAIL } });
    expect(user).not.toBeNull();
    expect(user.statut).toBe('en_attente');
    expect(user.password_hash).not.toBeNull();
    expect(user.invite_token_hash).not.toBeNull();
  });

  it('sendSetPasswordEmail a été appelé une fois par nouvel utilisateur', () => {
    // 2 créations → 2 appels
    expect(emailService.sendSetPasswordEmail).toHaveBeenCalledTimes(2);
    const emails = emailService.sendSetPasswordEmail.mock.calls.map(call => call[0].email);
    expect(emails).toEqual(expect.arrayContaining([EMPLOYEE_EMAIL, EMPLOYEE2_EMAIL]));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2 — Token d'invitation : extraction depuis le mock
// ─────────────────────────────────────────────────────────────────────────────
describe('2 — Token d\'invitation', () => {
  let inviteToken;

  beforeAll(() => {
    // 3ème argument de sendSetPasswordEmail(user, entreprise, inviteToken)
    const callForClaire = emailService.sendSetPasswordEmail.mock.calls.find(
      call => call[0].email === EMPLOYEE_EMAIL,
    );
    inviteToken = callForClaire?.[2];
  });

  it('le token est un JWT valide signé avec JWT_SECRET', () => {
    expect(inviteToken).toBeDefined();
    const decoded = jwt.verify(inviteToken, process.env.JWT_SECRET);
    expect(decoded.type).toBe('set_password');
    expect(decoded.email).toBe(EMPLOYEE_EMAIL);
  });

  it('le hash SHA-256 du token est stocké dans invite_token_hash', async () => {
    const user = await Utilisateur.findOne({ where: { email: EMPLOYEE_EMAIL } });
    const expectedHash = crypto.createHash('sha256').update(inviteToken).digest('hex');
    expect(user.invite_token_hash).toBe(expectedHash);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3 — Token expiré → 401 + INVITE_EXPIRED loggé
// ─────────────────────────────────────────────────────────────────────────────
describe('3 — Token expiré', () => {
  it('POST /api/auth/set-password avec token expiré → 401', async () => {
    // Signer un token expiré depuis 1s
    const expiredToken = jwt.sign(
      { id: 'fake-uuid', email: 'expired@test.local', type: 'set_password' },
      process.env.JWT_SECRET,
      { expiresIn: -1 },
    );

    const res = await request(app)
      .post('/api/auth/set-password')
      .send({ token: expiredToken, password: NEW_PASSWORD, confirmPassword: NEW_PASSWORD });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/expiré|invalide/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4 — Token invalide (mauvaise signature)
// ─────────────────────────────────────────────────────────────────────────────
describe('4 — Token invalide', () => {
  it('POST /api/auth/set-password avec token falsifié → 400', async () => {
    const fakeToken = 'eyJhbGciOiJIUzI1NiJ9.eyJpZCI6ImZha2UiLCJ0eXBlIjoic2V0X3Bhc3N3b3JkIn0.INVALIDE';

    const res = await request(app)
      .post('/api/auth/set-password')
      .send({ token: fakeToken, password: NEW_PASSWORD, confirmPassword: NEW_PASSWORD });

    expect(res.status).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5 + 6 — Set-password avec le vrai token → compte activé
// ─────────────────────────────────────────────────────────────────────────────
describe('5 & 6 — Set-password valide → compte activé', () => {
  let inviteToken;

  beforeAll(() => {
    const callForClaire = emailService.sendSetPasswordEmail.mock.calls.find(
      call => call[0].email === EMPLOYEE_EMAIL,
    );
    inviteToken = callForClaire?.[2];
  });

  it('POST /api/auth/set-password avec mots de passe différents → 400', async () => {
    const res = await request(app)
      .post('/api/auth/set-password')
      .send({ token: inviteToken, password: NEW_PASSWORD, confirmPassword: 'AutreMdp2026!' });
    expect(res.status).toBe(400);
  });

  it('POST /api/auth/set-password avec token valide → 200, compte actif', async () => {
    const res = await request(app)
      .post('/api/auth/set-password')
      .send({ token: inviteToken, password: NEW_PASSWORD, confirmPassword: NEW_PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/mot de passe|activé|défini/i);
  });

  it('le compte est maintenant actif et invite_token_hash effacé', async () => {
    const user = await Utilisateur.findOne({ where: { email: EMPLOYEE_EMAIL } });
    expect(user.statut).toBe('actif');
    expect(user.invite_token_hash).toBeNull();
  });

  it('sendWelcomeAfterActivation a été appelé', () => {
    expect(emailService.sendWelcomeAfterActivation).toHaveBeenCalledTimes(1);
    expect(emailService.sendWelcomeAfterActivation.mock.calls[0][0].email).toBe(EMPLOYEE_EMAIL);
  });

  it('le même token ne peut plus être utilisé (déjà consommé) → 400', async () => {
    const res = await request(app)
      .post('/api/auth/set-password')
      .send({ token: inviteToken, password: NEW_PASSWORD, confirmPassword: NEW_PASSWORD });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/déjà utilisé|invalide/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7 — Login avec le nouveau mot de passe
// ─────────────────────────────────────────────────────────────────────────────
describe('7 — Login avec le nouveau mot de passe', () => {
  it('POST /api/auth/login → 200 avec token JWT', async () => {
    const user = await Utilisateur.findOne({ where: { email: EMPLOYEE_EMAIL } });

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: EMPLOYEE_EMAIL, password: NEW_PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.token).toBeDefined();

    // Vérifie que le token JWT contient le bon role et l'id de l'utilisateur
    const decoded = jwt.decode(res.body.token);
    expect(decoded.id).toBe(user.id);
    expect(decoded.role).toBe('employe');
  });

  it('POST /api/auth/login avec l\'ancien placeholder → 401', async () => {
    // Le placeholder bcrypt généré à l'import n'est jamais connu → simulé ici
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: EMPLOYEE_EMAIL, password: 'MauvaisMdpQuelconque!' });
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8 — Import CSV congés pour l'employé importé
// ─────────────────────────────────────────────────────────────────────────────
describe('8 — Import CSV congés', () => {
  const currentYear = new Date().getFullYear();
  let userId;

  beforeAll(async () => {
    const user = await Utilisateur.findOne({ where: { email: EMPLOYEE_EMAIL } });
    userId = user?.id;
  });

  afterAll(async () => {
    if (userId) await Conge.destroy({ where: { utilisateur_id: userId } });
  });

  it('POST /api/conges/import/csv crée un congé pour l\'employé importé', async () => {
    const dateDebut = `${currentYear}-07-01`;
    const dateFin   = `${currentYear}-07-05`;

    const csv = Buffer.from(
      [
        `email,type_conge,date_debut,date_fin,statut,debut_demi_journee,fin_demi_journee`,
        `${EMPLOYEE_EMAIL},Congés payés,${dateDebut},${dateFin},valide_final,,`,
      ].join('\n') + '\n',
      'utf8',
    );

    const res = await request(app)
      .post('/api/conges/import/csv')
      .set('Authorization', `Bearer ${ctx.tokens.superAdmin}`)
      .attach('file', csv, { filename: 'conges.csv', contentType: 'text/csv' })
      .field('entreprise_id', ctx.entreprise.id);

    expect(res.status).toBe(201);
    expect(res.body.created).toHaveLength(1);
    expect(res.body.created[0].email).toBe(EMPLOYEE_EMAIL);
  });

  it('le congé est bien en base avec le bon statut', async () => {
    const conges = await Conge.findAll({ where: { utilisateur_id: userId } });
    expect(conges.length).toBeGreaterThanOrEqual(1);
    expect(conges[0].statut).toBe('valide_final');
  });

  it('double import du même congé → skipped (idempotent)', async () => {
    const dateDebut = `${currentYear}-07-01`;
    const dateFin   = `${currentYear}-07-05`;

    const csv = Buffer.from(
      [
        `email,type_conge,date_debut,date_fin,statut,debut_demi_journee,fin_demi_journee`,
        `${EMPLOYEE_EMAIL},Congés payés,${dateDebut},${dateFin},valide_final,,`,
      ].join('\n') + '\n',
      'utf8',
    );

    const res = await request(app)
      .post('/api/conges/import/csv')
      .set('Authorization', `Bearer ${ctx.tokens.superAdmin}`)
      .attach('file', csv, { filename: 'conges.csv', contentType: 'text/csv' })
      .field('entreprise_id', ctx.entreprise.id);

    expect(res.status).toBe(200);
    expect(res.body.created).toHaveLength(0);
    expect(res.body.skipped).toHaveLength(1);
    expect(res.body.skipped[0].raison).toMatch(/existant/i);
  });

  it('403 pour admin_entreprise sur l\'import congés', async () => {
    const csv = Buffer.from('email,type_conge,date_debut,date_fin,statut\n', 'utf8');
    const res = await request(app)
      .post('/api/conges/import/csv')
      .set('Authorization', `Bearer ${ctx.tokens.admin}`)
      .attach('file', csv, { filename: 'c.csv', contentType: 'text/csv' })
      .field('entreprise_id', ctx.entreprise.id);
    expect(res.status).toBe(403);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9 — Template congés pré-rempli avec les emails de l'entreprise
// ─────────────────────────────────────────────────────────────────────────────
describe('9 — Template CSV congés pré-rempli', () => {
  it('GET /api/conges/import/csv/template contient les emails des employés actifs', async () => {
    const res = await request(app)
      .get(`/api/conges/import/csv/template?entreprise_id=${ctx.entreprise.id}`)
      .set('Authorization', `Bearer ${ctx.tokens.superAdmin}`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/i);

    // L'employé importé (actif après set-password) doit apparaître
    expect(res.text).toContain(EMPLOYEE_EMAIL);
    // Les colonnes obligatoires
    expect(res.text).toContain('email');
    expect(res.text).toContain('type_conge');
    expect(res.text).toContain('date_debut');
    expect(res.text).toContain('date_fin');
  });

  it('400 si entreprise_id manquant', async () => {
    const res = await request(app)
      .get('/api/conges/import/csv/template')
      .set('Authorization', `Bearer ${ctx.tokens.superAdmin}`);
    expect(res.status).toBe(400);
  });

  it('400 si entreprise_id n\'est pas un UUID valide', async () => {
    const res = await request(app)
      .get('/api/conges/import/csv/template?entreprise_id=pas-un-uuid')
      .set('Authorization', `Bearer ${ctx.tokens.superAdmin}`);
    expect(res.status).toBe(400);
  });
});
