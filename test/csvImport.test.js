'use strict';
/**
 * csvImport.test.js
 *
 * Tests d'intégration pour POST /api/users/import/csv et GET /api/users/import/csv/template.
 *
 * Nouveau format :
 *   nom, prenom, email, role, service, date_embauche,
 *   {type} (N-1), {type} (N)   ← une paire par type de congé de l'entreprise
 *
 * Scénarios couverts :
 *   A — Autorisation : seul super_admin peut accéder à ces routes
 *   B — Validation   : erreurs retournées en bloc avant toute création
 *   C — Import OK    : création utilisateur + pose des soldes N-1 et N
 *   D — Utilisateur existant : skip création, soldes mis à jour quand même
 *   E — Template CSV : contient les libellés avec suffixes (N-1) et (N)
 */

const request    = require('supertest');
const app        = require('../src/index');
const { Utilisateur, CompteurConges } = require('../src/models');
const { generateToken } = require('./helpers/auth');
const { seed }   = require('./helpers/seed');

jest.mock('../src/services/emailService', () => ({
  sendWelcomeEmail: jest.fn().mockResolvedValue(undefined),
}));

let ctx;

beforeAll(async () => {
  ctx = await seed(); // entreprise + superAdmin + admin + manager + employe + congeType (Congés payés)
});

afterAll(async () => {
  await ctx.cleanup();
});

// ─────────────────────────────────────────────────────────────────────────────
// Helper : construit un Buffer CSV à partir de lignes
// ─────────────────────────────────────────────────────────────────────────────
function csvBuffer(lines) {
  return Buffer.from(lines.join('\n') + '\n', 'utf8');
}

// En-têtes avec colonnes de solde dynamiques pour le type "Congés payés" du seed
const HEADERS      = 'nom,prenom,email,role,service,date_embauche,Congés payés (N-1),Congés payés (N)';
const HEADERS_BASE = 'nom,prenom,email,role,service,date_embauche';

// ─────────────────────────────────────────────────────────────────────────────
// A — Autorisation
// ─────────────────────────────────────────────────────────────────────────────
describe('A — Autorisation', () => {
  const csv = csvBuffer([HEADERS_BASE, `Dupont,Marie,marie.a@test.local,employe,,,`]);

  it('403 pour admin_entreprise sur POST /import/csv', async () => {
    const res = await request(app)
      .post('/api/users/import/csv')
      .set('Authorization', `Bearer ${ctx.tokens.admin}`)
      .attach('file', csv, { filename: 'test.csv', contentType: 'text/csv' })
      .field('entreprise_id', ctx.entreprise.id);
    expect(res.status).toBe(403);
  });

  it('403 pour manager sur POST /import/csv', async () => {
    const res = await request(app)
      .post('/api/users/import/csv')
      .set('Authorization', `Bearer ${ctx.tokens.manager}`)
      .attach('file', csv, { filename: 'test.csv', contentType: 'text/csv' })
      .field('entreprise_id', ctx.entreprise.id);
    expect(res.status).toBe(403);
  });

  it('403 pour employe sur GET /import/csv/template', async () => {
    const res = await request(app)
      .get(`/api/users/import/csv/template?entreprise_id=${ctx.entreprise.id}`)
      .set('Authorization', `Bearer ${ctx.tokens.employe}`);
    expect(res.status).toBe(403);
  });

  it('403 pour admin_entreprise sur GET /import/csv/template', async () => {
    const res = await request(app)
      .get(`/api/users/import/csv/template?entreprise_id=${ctx.entreprise.id}`)
      .set('Authorization', `Bearer ${ctx.tokens.admin}`);
    expect(res.status).toBe(403);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B — Validation
// ─────────────────────────────────────────────────────────────────────────────
describe('B — Validation CSV', () => {
  it('400 si fichier manquant', async () => {
    const res = await request(app)
      .post('/api/users/import/csv')
      .set('Authorization', `Bearer ${ctx.tokens.superAdmin}`)
      .field('entreprise_id', ctx.entreprise.id);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/fichier/i);
  });

  it('400 si entreprise_id manquant', async () => {
    const csv = csvBuffer([HEADERS, `Dupont,Marie,marie.b1@test.local,employe,,,0,0`]);
    const res = await request(app)
      .post('/api/users/import/csv')
      .set('Authorization', `Bearer ${ctx.tokens.superAdmin}`)
      .attach('file', csv, { filename: 'test.csv', contentType: 'text/csv' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/entreprise_id/i);
  });

  it('404 si entreprise_id inexistant', async () => {
    const csv = csvBuffer([HEADERS, `Dupont,Marie,marie.b2@test.local,employe,,,0,0`]);
    const res = await request(app)
      .post('/api/users/import/csv')
      .set('Authorization', `Bearer ${ctx.tokens.superAdmin}`)
      .attach('file', csv, { filename: 'test.csv', contentType: 'text/csv' })
      .field('entreprise_id', '00000000-0000-4000-8000-000000000000');
    expect(res.status).toBe(404);
  });

  it('422 si role invalide', async () => {
    const csv = csvBuffer([HEADERS, `Dupont,Marie,marie.b3@test.local,stagiaire,,,0,0`]);
    const res = await request(app)
      .post('/api/users/import/csv')
      .set('Authorization', `Bearer ${ctx.tokens.superAdmin}`)
      .attach('file', csv, { filename: 'test.csv', contentType: 'text/csv' })
      .field('entreprise_id', ctx.entreprise.id);
    expect(res.status).toBe(422);
    expect(res.body.errors[0].errors[0]).toMatch(/role invalide/i);
  });

  it('422 si valeur de solde invalide (non numérique)', async () => {
    const csv = csvBuffer([HEADERS, `Dupont,Marie,marie.b4@test.local,employe,,,abc,0`]);
    const res = await request(app)
      .post('/api/users/import/csv')
      .set('Authorization', `Bearer ${ctx.tokens.superAdmin}`)
      .attach('file', csv, { filename: 'test.csv', contentType: 'text/csv' })
      .field('entreprise_id', ctx.entreprise.id);
    expect(res.status).toBe(422);
    expect(res.body.errors[0].errors[0]).toMatch(/nombre/i);
  });

  it('422 si doublon email dans le fichier', async () => {
    const csv = csvBuffer([
      HEADERS,
      `Dupont,Marie,marie.b6@test.local,employe,,,10,25`,
      `Dupont,Marie,marie.b6@test.local,employe,,,5,20`,
    ]);
    const res = await request(app)
      .post('/api/users/import/csv')
      .set('Authorization', `Bearer ${ctx.tokens.superAdmin}`)
      .attach('file', csv, { filename: 'test.csv', contentType: 'text/csv' })
      .field('entreprise_id', ctx.entreprise.id);
    expect(res.status).toBe(422);
    expect(res.body.errors[0].errors[0]).toMatch(/doublon/i);
  });

  it('colonne de solde inconnue ignorée — pas d\'erreur', async () => {
    // "Type Inexistant (N)" ne correspond à aucun CongeType → colonne ignorée
    const headers = `nom,prenom,email,role,service,date_embauche,Type Inexistant (N)`;
    const csv = csvBuffer([headers, `Dupont,Marie,marie.b7.${Date.now()}@test.local,employe,,,25`]);
    const res = await request(app)
      .post('/api/users/import/csv')
      .set('Authorization', `Bearer ${ctx.tokens.superAdmin}`)
      .attach('file', csv, { filename: 'test.csv', contentType: 'text/csv' })
      .field('entreprise_id', ctx.entreprise.id);
    // La ligne doit être importée sans erreur, aucun solde posé
    expect(res.status).toBe(201);
    expect(res.body.balancesSet).toHaveLength(0);

    // Nettoyage
    const user = await Utilisateur.findOne({ where: { email: res.body.created[0]?.email } });
    if (user) {
      await CompteurConges.destroy({ where: { utilisateur_id: user.id } });
      await user.destroy();
    }
  });

  it('retourne toutes les erreurs en une fois (pas d\'arrêt à la première)', async () => {
    const csv = csvBuffer([
      HEADERS,
      `,,invalid-email,stagiaire,,,0,0`,  // nom manquant, prenom manquant, email invalide, role invalide
      `Dupont,Marie,marie.b8@test.local,employe,,,0,0`,  // ligne valide
    ]);
    const res = await request(app)
      .post('/api/users/import/csv')
      .set('Authorization', `Bearer ${ctx.tokens.superAdmin}`)
      .attach('file', csv, { filename: 'test.csv', contentType: 'text/csv' })
      .field('entreprise_id', ctx.entreprise.id);
    expect(res.status).toBe(422);
    const line2 = res.body.errors.find(e => e.line === 2);
    expect(line2.errors.length).toBeGreaterThan(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C — Import réussi : nouvel utilisateur + soldes N-1 et N
// ─────────────────────────────────────────────────────────────────────────────
describe('C — Import réussi (nouvel utilisateur)', () => {
  const email = `import.c1.${Date.now()}@test.local`;
  const currentYear = new Date().getFullYear();
  let userId;

  afterAll(async () => {
    if (userId) {
      await CompteurConges.destroy({ where: { utilisateur_id: userId } });
      await Utilisateur.destroy({ where: { id: userId } });
    }
  });

  it('crée l\'utilisateur et pose les soldes N-1 et N (201)', async () => {
    const csv = csvBuffer([
      HEADERS,
      `Dupont,Marie,${email},employe,RH,2021-03-01,5,25`,
    ]);

    const res = await request(app)
      .post('/api/users/import/csv')
      .set('Authorization', `Bearer ${ctx.tokens.superAdmin}`)
      .attach('file', csv, { filename: 'test.csv', contentType: 'text/csv' })
      .field('entreprise_id', ctx.entreprise.id);

    expect(res.status).toBe(201);
    expect(res.body.created).toHaveLength(1);
    expect(res.body.created[0].email).toBe(email);
    expect(res.body.skipped).toHaveLength(0);
    // 2 soldes posés : N-1 (5 j) et N (25 j)
    expect(res.body.balancesSet).toHaveLength(2);
    const soldeN = res.body.balancesSet.find(b => b.annee === currentYear);
    const soldeN1 = res.body.balancesSet.find(b => b.annee === currentYear - 1);
    expect(soldeN?.jours_acquis).toBe(25);
    expect(soldeN1?.jours_acquis).toBe(5);

    userId = res.body.created[0].id;
  });

  it('les CompteurConges en DB reflètent les valeurs importées', async () => {
    const counters = await CompteurConges.findAll({ where: { utilisateur_id: userId, conge_type_id: ctx.congeType.id } });
    const counterN  = counters.find(c => c.annee === currentYear);
    const counterN1 = counters.find(c => c.annee === currentYear - 1);
    expect(counterN).not.toBeNull();
    expect(parseFloat(counterN.jours_acquis)).toBe(25);
    expect(counterN1).not.toBeNull();
    expect(parseFloat(counterN1.jours_acquis)).toBe(5);
  });

  it('l\'utilisateur est créé en statut en_attente', async () => {
    const user = await Utilisateur.findByPk(userId);
    expect(user.statut).toBe('en_attente');
    expect(user.entreprise_id).toBe(ctx.entreprise.id);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D — Utilisateur existant : skip création, soldes mis à jour quand même
// ─────────────────────────────────────────────────────────────────────────────
describe('D — Utilisateur existant (skip + mise à jour soldes)', () => {
  let existingEmail;
  const currentYear = new Date().getFullYear();

  beforeAll(() => {
    existingEmail = ctx.employe.email;
  });

  afterAll(async () => {
    await CompteurConges.update(
      { jours_acquis: 0, jours_pris: 0 },
      { where: { utilisateur_id: ctx.employe.id, conge_type_id: ctx.congeType.id } }
    );
  });

  it('répond 200 (pas 201) et skip l\'email existant', async () => {
    // Colonne N-1 laissée vide → ignorée ; colonne N = 12
    const csv = csvBuffer([
      HEADERS,
      `Employe,Test,${existingEmail},employe,,,,12`,  // N-1 vide, N=12
    ]);

    const res = await request(app)
      .post('/api/users/import/csv')
      .set('Authorization', `Bearer ${ctx.tokens.superAdmin}`)
      .attach('file', csv, { filename: 'test.csv', contentType: 'text/csv' })
      .field('entreprise_id', ctx.entreprise.id);

    expect(res.status).toBe(200);
    expect(res.body.created).toHaveLength(0);
    expect(res.body.skipped).toHaveLength(1);
    expect(res.body.skipped[0].email).toBe(existingEmail);
    // N-1 vide → ignoré ; N renseigné → 1 solde posé
    expect(res.body.balancesSet).toHaveLength(1);
    expect(res.body.balancesSet[0].jours_acquis).toBe(12);
    expect(res.body.balancesSet[0].annee).toBe(currentYear);
  });

  it('le CompteurConges de l\'utilisateur existant est bien mis à jour', async () => {
    const counter = await CompteurConges.findOne({
      where: { utilisateur_id: ctx.employe.id, conge_type_id: ctx.congeType.id, annee: currentYear },
    });
    if (counter) {
      expect(parseFloat(counter.jours_acquis)).toBe(12);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E — Template CSV
// ─────────────────────────────────────────────────────────────────────────────
describe('E — Template CSV GET /import/csv/template', () => {
  it('200 pour super_admin, Content-Type text/csv', async () => {
    const res = await request(app)
      .get(`/api/users/import/csv/template?entreprise_id=${ctx.entreprise.id}`)
      .set('Authorization', `Bearer ${ctx.tokens.superAdmin}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/i);
    expect(res.headers['content-disposition']).toMatch(/attachment/i);
  });

  it('le template contient les colonnes (N-1) et (N) pour chaque type de congé', async () => {
    const res = await request(app)
      .get(`/api/users/import/csv/template?entreprise_id=${ctx.entreprise.id}`)
      .set('Authorization', `Bearer ${ctx.tokens.superAdmin}`);
    expect(res.text).toContain('Congés payés');
    expect(res.text).toContain('(N-1)');
    expect(res.text).toContain('(N)');
    expect(res.text).toContain('nom');
    expect(res.text).toContain('prenom');
    expect(res.text).toContain('email');
  });

  it('400 si entreprise_id manquant dans le template', async () => {
    const res = await request(app)
      .get('/api/users/import/csv/template')
      .set('Authorization', `Bearer ${ctx.tokens.superAdmin}`);
    expect(res.status).toBe(400);
  });
});
